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
import * as route53 from "aws-cdk-lib/aws-route53";
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
import { PrivateWebsite } from "./private-website"
import { PublicWebsite } from "./public-website"

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
    
    // Bucket Creation and website hosting
    let domainName: string;
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


    const websiteBucket = new s3.Bucket(this, "WebsiteBucket", {
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
    
    // Deploy either Private (only accessible within VPC) or Public facing website
    let apiEndpoint: string;
    let websocketEndpoint: string;
    if (props.config.privateWebsite) {
      const privateWebsite = new PrivateWebsite(this, "PrivateWebsite", {...props, websiteBucket: websiteBucket });
      apiEndpoint = `https://${props.api.restApi.restApiId}-${props.api.endpointAPIGateway.vpcEndpointId}.execute-api.${cdk.Aws.REGION}.${cdk.Aws.URL_SUFFIX}/api`
      websocketEndpoint = ''
    } else {
      const publicWebsite = new PublicWebsite(this, "PublicWebsite", {...props, websiteBucket: websiteBucket });
      apiEndpoint = `https://${publicWebsite.distribution.distributionDomainName}/api`
      websocketEndpoint = `wss://${publicWebsite.distribution.distributionDomainName}/socket`
    }

  
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
        api_endpoint: apiEndpoint,
        websocket_endpoint: websocketEndpoint, // ,`wss://${props.api.webSocketApi.apiId}.execute-api.${cdk.Aws.REGION}.${cdk.Aws.URL_SUFFIX}/socket`, //
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
          "public.ecr.aws/sam/build-nodejs18.x:latest"
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
      //distribution // TODO: take in distribution so invalidations occur on changes to UI 
    });

  }
}
