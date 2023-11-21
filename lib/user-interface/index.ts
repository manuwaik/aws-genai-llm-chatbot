import * as apigwv2 from "@aws-cdk/aws-apigatewayv2-alpha";
import * as cognitoIdentityPool from "@aws-cdk/aws-cognito-identitypool-alpha";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cf from "aws-cdk-lib/aws-cloudfront";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { AwsCustomResource, AwsSdkCall } from "aws-cdk-lib/custom-resources";
import { IpTarget } from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import { Construct } from "constructs";
import {
  ExecSyncOptionsWithBufferEncoding,
  execSync,
} from "node:child_process";
import * as path from "node:path";
import { Shared } from "../shared";
import { SystemConfig } from "../shared/types";
import { Utils } from "../shared/utils";
import { ChatBotApi } from "../chatbot-api";

export interface UserInterfaceProps {
  readonly config: SystemConfig;
  readonly shared: Shared;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly identityPool: cognitoIdentityPool.IdentityPool;
  readonly api: ChatBotApi;
  readonly chatbotFilesBucket: s3.Bucket;
  readonly crossEncodersEnabled: boolean;
  readonly sagemakerEmbeddingsEnabled: boolean;
}

export class UserInterface extends Construct {
  constructor(scope: Construct, id: string, props: UserInterfaceProps) {
    super(scope, id);

    const appPath = path.join(__dirname, "react-app");
    const buildPath = path.join(appPath, "dist");
    
    // PRIVATE WEBSITE 
    // REQUIRES: 
    // 1. Certificate ARN and Domain of website to be added to 'bin/config.json': 
    //    "certificate" : "arn:aws:acm:ap-southeast-2:1234567890:certificate/XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXX",
    //    "domain" : "sub.example.com"
    
    
    // Website ALB 
    const albSecurityGroup = new ec2.SecurityGroup(this, 'WebsiteApplicationLoadBalancerSG', {
            vpc: props.shared.vpc,
            allowAllOutbound: false
        });

    albSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(443)
    );

    albSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(80)
    );

    albSecurityGroup.addEgressRule(
        ec2.Peer.ipv4(props.shared.vpc.vpcCidrBlock),
        ec2.Port.tcp(443)
    );

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
        vpc: props.shared.vpc,
        internetFacing: false,
        securityGroup: albSecurityGroup,
        vpcSubnets: props.shared.vpc.selectSubnets({
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
          }),
    });

    const albLogBucket = new s3.Bucket(this, 'ALBLoggingBucket', {

        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        enforceSSL: true,

    });
    loadBalancer.logAccessLogs(albLogBucket)
    
    // Adding Listener
    // Using ACM certificate ARN passed in through props/config file 
    let albListener: elbv2.ApplicationListener;
    if (props.config.certificate) {
        albListener = loadBalancer.addListener('ALBLHTTPS',
        {
            protocol: elbv2.ApplicationProtocol.HTTPS,
            port: 443,
            certificates: [elbv2.ListenerCertificate.fromArn(props.config.certificate)],
            sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS
        });
        const albListenerhttp = loadBalancer.addListener('ALBLHTTP',
        {
            protocol: elbv2.ApplicationProtocol.HTTP,
            port: 80,
            defaultAction: elbv2.ListenerAction.redirect({ port: '443', protocol: 'HTTPS' })
        });
    }
    else {
        albListener = loadBalancer.addListener('ALBLHTTP',
            {
                protocol: elbv2.ApplicationProtocol.HTTP,
                port: 80
            });
    }
    
    // The Amazon S3 PrivateLink Endpoint is a REST API Endpoint, which means that trailing slash requests will return XML directory listings by default.
    // To work around this, you’ll create a redirect rule to point all requests ending in a trailing slash to index.html.
   albListener.addAction('privateLinkRedirectPath', {
    priority: 1,
    conditions: [
      elbv2.ListenerCondition.pathPatterns(['*/']),
    ],
    action: elbv2.ListenerAction.redirect({
      port: '#{port}',
      path: '/#{path}index.html',
    })
  });
    
     // Adding Website Target
    const s3EndpointId = props.shared.s3vpcEndpoint.vpcEndpointId
    const vpc = props.shared.vpc

    // First, retrieve the VPC Endpoint
    const vpcEndpointsCall: AwsSdkCall = {
        service: 'EC2',
        action: 'describeVpcEndpoints',
        parameters: {
            VpcEndpointIds: [s3EndpointId]
        },
        physicalResourceId: cdk.custom_resources.PhysicalResourceId.of('describeVpcEndpoints'),
        outputPaths: ['VpcEndpoints.0.NetworkInterfaceIds']
    }

    const vpcEndpoints = new AwsCustomResource(
        this, 'describeVpcEndpoints', {
        onCreate: vpcEndpointsCall,
        onUpdate: vpcEndpointsCall,
        policy: {
            statements: [
                new cdk.aws_iam.PolicyStatement({
                    actions: ["ec2:DescribeVpcEndpoints"],
                    resources: ["*"]
                })]
        }
    })

    // Then, retrieve the Private IP Addresses for each ENI of the VPC Endpoint
    let s3IPs: IpTarget[] = [];
    for (let index = 0; index < vpc.availabilityZones.length; index++) {
        const sdkCall: AwsSdkCall = {
            service: 'EC2',
            action: 'describeNetworkInterfaces',
            outputPaths: [`NetworkInterfaces.0.PrivateIpAddress`],
            parameters: {
                NetworkInterfaceIds: [vpcEndpoints.getResponseField(`VpcEndpoints.0.NetworkInterfaceIds.${index}`)],
                Filters: [
                    { Name: "interface-type", Values: ["vpc_endpoint"] }
                ],
            },
            physicalResourceId: cdk.custom_resources.PhysicalResourceId.of('describeNetworkInterfaces'),
        }

        const eni = new AwsCustomResource(
            this,
            `DescribeNetworkInterfaces-${index}`,
            {
                onCreate: sdkCall,
                onUpdate: sdkCall,
                policy: {
                    statements: [
                        new cdk.aws_iam.PolicyStatement({
                            actions: ["ec2:DescribeNetworkInterfaces"],
                            resources: ["*"],
                        }),
                    ],
                },
            }
        );

        s3IPs.push(new IpTarget(cdk.Token.asString(eni.getResponseField(`NetworkInterfaces.0.PrivateIpAddress`)), 443))
    }

    albListener.addTargets('s3TargetGroup',
        {
            port: 443,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            targets: s3IPs,
            healthCheck: {
                protocol: elbv2.Protocol.HTTPS,
                path: '/',
                healthyHttpCodes: '307,405'
            }
        });
        
    // Bucket Creation and website hosting
    let websiteBucket: s3.Bucket;
    let domainName: string;
    let httpProtocol: string;
    let wsProtocol: string;
    if (props.config.domain) {
      domainName = props.config.domain;
    } else {
      domainName = ""
    }
    
    const uploadLogsBucket = new s3.Bucket(this, "WebsiteLogsBucket", {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        enforceSSL: true,
      }
      );

    websiteBucket = new s3.Bucket(this, "WebsiteBucket", {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        autoDeleteObjects: true,
        bucketName: domainName,
        versioned: true,
        serverAccessLogsBucket: uploadLogsBucket,
        enforceSSL: true,
        websiteIndexDocument: "index.html",
        websiteErrorDocument: "index.html",
    });

    websiteBucket.policy?.document.addStatements(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject', "s3:List*"],
            principals: [new iam.AnyPrincipal()], // TODO: restrict to the S3 VPC Endpoints
            resources: [websiteBucket.bucketArn, `${websiteBucket.bucketArn}/*`],
            conditions: {
                "StringEquals": { "aws:SourceVpce": s3EndpointId }
            }
        })
    );
    
    // TODO: Add route53 record to loadbalancer
    
    
    
    // ORIGINAL CLOUDFRONT IMPLEMENTATION
    
    // const originAccessIdentity = new cf.OriginAccessIdentity(this, "S3OAI");
    // websiteBucket.grantRead(originAccessIdentity);
    // props.chatbotFilesBucket.grantRead(originAccessIdentity);

    // const distribution = new cf.CloudFrontWebDistribution(
    //   this,
    //   "Distirbution",
    //   {
    //     viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    //     priceClass: cf.PriceClass.PRICE_CLASS_ALL,
    //     httpVersion: cf.HttpVersion.HTTP2_AND_3,
    //     originConfigs: [
    //       {
    //         behaviors: [{ isDefaultBehavior: true }],
    //         s3OriginSource: {
    //           s3BucketSource: websiteBucket,
    //           originAccessIdentity,
    //         },
    //       },
    //       {
    //         behaviors: [
    //           {
    //             pathPattern: "/api/*",
    //             allowedMethods: cf.CloudFrontAllowedMethods.ALL,
    //             viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    //             defaultTtl: cdk.Duration.seconds(0),
    //             forwardedValues: {
    //               queryString: true,
    //               headers: [
    //                 "Referer",
    //                 "Origin",
    //                 "Authorization",
    //                 "Content-Type",
    //                 "x-forwarded-user",
    //                 "Access-Control-Request-Headers",
    //                 "Access-Control-Request-Method",
    //               ],
    //             },
    //           },
    //         ],
    //         customOriginSource: {
    //           domainName: `${props.api.restApi.restApiId}-${props.api.endpointAPIGateway.vpcEndpointId}.execute-api.${cdk.Aws.REGION}.${cdk.Aws.URL_SUFFIX}`,
    //           originHeaders: {
    //             "X-Origin-Verify": props.shared.xOriginVerifySecret
    //               .secretValueFromJson("headerValue")
    //               .unsafeUnwrap(),
    //           },
    //         },
    //       },
    //       {
    //         behaviors: [
    //           {
    //             pathPattern: "/socket",
    //             allowedMethods: cf.CloudFrontAllowedMethods.ALL,
    //             viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    //             forwardedValues: {
    //               queryString: true,
    //               headers: [
    //                 "Sec-WebSocket-Key",
    //                 "Sec-WebSocket-Version",
    //                 "Sec-WebSocket-Protocol",
    //                 "Sec-WebSocket-Accept",
    //                 "Sec-WebSocket-Extensions",
    //               ],
    //             },
    //           },
    //         ],
    //         customOriginSource: {
    //           domainName: `${props.api.webSocketApi.apiId}.execute-api.${cdk.Aws.REGION}.${cdk.Aws.URL_SUFFIX}`,
    //           originHeaders: {
    //             "X-Origin-Verify": props.shared.xOriginVerifySecret
    //               .secretValueFromJson("headerValue")
    //               .unsafeUnwrap(),
    //           },
    //         },
    //       },
    //       {
    //         behaviors: [
    //           {
    //             pathPattern: "/chabot/files/*",
    //             allowedMethods: cf.CloudFrontAllowedMethods.ALL,
    //             viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    //             defaultTtl: cdk.Duration.seconds(0),
    //             forwardedValues: {
    //               queryString: true,
    //               headers: [
    //                 "Referer",
    //                 "Origin",
    //                 "Authorization",
    //                 "Content-Type",
    //                 "x-forwarded-user",
    //                 "Access-Control-Request-Headers",
    //                 "Access-Control-Request-Method",
    //               ],
    //             },
    //           },
    //         ],
    //         s3OriginSource: {
    //           s3BucketSource: props.chatbotFilesBucket,
    //           originAccessIdentity,
    //         },
    //       },
    //     ],
    //     errorConfigurations: [
    //       {
    //         errorCode: 404,
    //         errorCachingMinTtl: 0,
    //         responseCode: 200,
    //         responsePagePath: "/index.html",
    //       },
    //     ],
    //   }
    // );

    const exportsAsset = s3deploy.Source.jsonData("aws-exports.json", {
      aws_project_region: cdk.Aws.REGION,
      aws_cognito_region: cdk.Aws.REGION,
      aws_user_pools_id: props.userPoolId,
      aws_user_pools_web_client_id: props.userPoolClientId,
      aws_cognito_identity_pool_id: props.identityPool.identityPoolId,
      Auth: {
        region: cdk.Aws.REGION,
        userPoolId: props.userPoolId,
        userPoolWebClientId: props.userPoolClientId,
        identityPoolId: props.identityPool.identityPoolId,
      },
      aws_appsync_graphqlEndpoint: props.api.graphqlApi?.graphQLUrl,
      aws_appsync_region: cdk.Aws.REGION,
      aws_appsync_authenticationType: "AMAZON_COGNITO_USER_POOLS",
      aws_appsync_apiKey: props.api.graphqlApi?.apiKey,
      Storage: {
        AWSS3: {
          bucket: props.chatbotFilesBucket.bucketName,
          region: cdk.Aws.REGION,
        },
      },
      config: {
        api_endpoint: `https://${props.api.restApi.restApiId}-${props.api.endpointAPIGateway.vpcEndpointId}.execute-api.${cdk.Aws.REGION}.${cdk.Aws.URL_SUFFIX}/api`, //`https://${distribution.distributionDomainName}/api`,
        //websocket_endpoint: `wss://${props.api.webSocketApi.apiId}.execute-api.${cdk.Aws.REGION}.${cdk.Aws.URL_SUFFIX}/socket`, //`wss://${distribution.distributionDomainName}/socket`,
        appsync_endpoint: props.api.graphqlApi?.graphQLUrl, 
        rag_enabled: props.config.rag.enabled,
        cross_encoders_enabled: props.crossEncodersEnabled,
        sagemaker_embeddings_enabled: props.sagemakerEmbeddingsEnabled,
        default_embeddings_model: Utils.getDefaultEmbeddingsModel(props.config),
        default_cross_encoder_model: Utils.getDefaultCrossEncoderModel(
          props.config
        ),
      },
    });

    // Allow authenticated web users to read upload data to the attachments bucket for their chat files
    // ref: https://docs.amplify.aws/lib/storage/getting-started/q/platform/js/#using-amazon-s3
    props.identityPool.authenticatedRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [
          `${props.chatbotFilesBucket.bucketArn}/public/*`,
          `${props.chatbotFilesBucket.bucketArn}/protected/\${cognito-identity.amazonaws.com:sub}/*`,
          `${props.chatbotFilesBucket.bucketArn}/private/\${cognito-identity.amazonaws.com:sub}/*`,
        ],
      })
    );
    props.identityPool.authenticatedRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [`${props.chatbotFilesBucket.bucketArn}`],
        conditions: {
          StringLike: {
            "s3:prefix": [
              "public/",
              "public/*",
              "protected/",
              "protected/*",
              "private/${cognito-identity.amazonaws.com:sub}/",
              "private/${cognito-identity.amazonaws.com:sub}/*",
            ],
          },
        },
      })
    );

    // Enable CORS for the attachments bucket to allow uploads from the user interface
    // ref: https://docs.amplify.aws/lib/storage/getting-started/q/platform/js/#amazon-s3-bucket-cors-policy-setup
    props.chatbotFilesBucket.addCorsRule({
      allowedMethods: [
        s3.HttpMethods.GET,
        s3.HttpMethods.PUT,
        s3.HttpMethods.POST,
        s3.HttpMethods.DELETE,
      ],
      allowedOrigins: ["*"],
      allowedHeaders: ["*"],
      exposedHeaders: [
        "x-amz-server-side-encryption",
        "x-amz-request-id",
        "x-amz-id-2",
        "ETag",
      ],
      maxAge: 3000,
    });

    const asset = s3deploy.Source.asset(appPath, {
      bundling: {
        image: cdk.DockerImage.fromRegistry(
          "public.ecr.aws/sam/build-nodejs18.x:latest" // TODO: replace with a private ECR repo/image 
        ),
        command: [
          "sh",
          "-c",
          [
            "npm --cache /tmp/.npm install",
            `npm --cache /tmp/.npm run build`,
            "cp -aur /asset-input/dist/* /asset-output/",
          ].join(" && "),
        ],
        local: {
          tryBundle(outputDir: string) {
            try {
              const options: ExecSyncOptionsWithBufferEncoding = {
                stdio: "inherit",
                env: {
                  ...process.env,
                },
              };

              execSync(`npm --silent --prefix "${appPath}" ci`, options);
              execSync(`npm --silent --prefix "${appPath}" run build`, options);
              Utils.copyDirRecursive(buildPath, outputDir);
            } catch (e) {
              console.error(e);
              return false;
            }

            return true;
          },
        },
      },
    });

    new s3deploy.BucketDeployment(this, "UserInterfaceDeployment", {
      prune: false,
      sources: [asset, exportsAsset],
      destinationBucket: websiteBucket,
      //distribution,
    });

    // ###################################################
    // Outputs
    // ###################################################
    // new cdk.CfnOutput(this, "UserInterfaceDomainName", {
    //   value: `https://${distribution.distributionDomainName}`,
    // });
  }
}
