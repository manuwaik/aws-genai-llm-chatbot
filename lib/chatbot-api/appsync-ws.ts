import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Code, Function, LayerVersion, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";
import { Shared } from "../shared";
import { IQueue } from "aws-cdk-lib/aws-sqs";
import { ITopic } from "aws-cdk-lib/aws-sns";
import { UserPool } from "aws-cdk-lib/aws-cognito";

interface ChatGraphqlApiProps {
    readonly queue: IQueue;
    readonly topic: ITopic;
    readonly userPool: UserPool;
    readonly shared: Shared;
}

export class ChatGraphqlApi extends Construct {
    public readonly apiKey: string | undefined;
    public readonly graphQLUrl: string | undefined;

    constructor(scope: Construct, id: string, props: ChatGraphqlApiProps) {
        super(scope, id);

        const powertoolsLayerJS = LayerVersion.fromLayerVersionArn(
            this,
            'PowertoolsLayerJS',
            `arn:aws:lambda:${cdk.Stack.of(this).region}:094274105915:layer:AWSLambdaPowertoolsTypeScript:22`
        );

        // makes a GraphQL API
        const api = new appsync.GraphqlApi(this, "ws-api", {
            name: "chatbot-ws-api",
            schema: appsync.SchemaFile.fromAsset(
                "lib/chatbot-api/schema/schema-ws.graphql"
            ),
            authorizationConfig: {
                additionalAuthorizationModes: [
                    {
                        authorizationType: appsync.AuthorizationType.IAM
                    },
                    {
                        authorizationType: appsync.AuthorizationType.USER_POOL,
                        userPoolConfig: {
                            userPool: props.userPool
                        }
                    }
                ],
            },
            xrayEnabled: true,
        });


        const resolverFunction = new Function(this, "lambda-resolver", {
            code: Code.fromAsset(
                "./lib/chatbot-api/functions/resolvers/lambda-resolver"
            ),
            handler: "index.handler",
            runtime: Runtime.PYTHON_3_11,
            environment: {
                SNS_TOPIC_ARN: props.topic.topicArn
            },
            layers: [props.shared.powerToolsLayer]
        });

        const outgoingMessageAppsync = new Function(this, "outgoing-message-handler", {
            code: Code.fromAsset(
                "./lib/chatbot-api/functions/outgoing-message-appsync"
            ),
            layers: [powertoolsLayerJS],
            handler: "index.handler",
            runtime: Runtime.NODEJS_18_X,
        })

        outgoingMessageAppsync.addEventSource(new SqsEventSource(props.queue));

        props.topic.grantPublish(resolverFunction);

        const functionDataSource = api.addLambdaDataSource(
            "resolver-function-source",
            resolverFunction
        );
        const noneDataSource = api.addNoneDataSource("none", {
            name: "relay-source",
        });

        api.createResolver("send-message-resolver", {
            typeName: "Mutation",
            fieldName: "sendQuery",
            code: appsync.Code.fromAsset(
                "./lib/chatbot-api/functions/resolvers/send-query-resolver.js"
            ),
            runtime: appsync.FunctionRuntime.JS_1_0_0,
            dataSource: functionDataSource,
        });

        api.grantMutation(outgoingMessageAppsync);

        api.createResolver("publish-response-resolver", {
            typeName: "Mutation",
            fieldName: "publishResponse",
            code: appsync.Code.fromAsset(
                "./lib/chatbot-api/functions/resolvers/publish-response-resolver.js"
            ),
            runtime: appsync.FunctionRuntime.JS_1_0_0,
            dataSource: noneDataSource,
        });

        api.createResolver("subscription-resolver", {
            typeName: "Subscription",
            fieldName: "receiveMessage",
            code: appsync.Code.fromAsset(
                "./lib/chatbot-api/functions/resolvers/receive-message-resolver.js"
            ),
            runtime: appsync.FunctionRuntime.JS_1_0_0,
            dataSource: noneDataSource,
        });

        // Prints out URL
        new cdk.CfnOutput(this, "GraphqlWSAPIURL", {
            value: api.graphqlUrl,
        });

        // Prints out the AppSync GraphQL API key to the terminal
        new cdk.CfnOutput(this, "GraphqlWSAPIKey", {
            value: api.apiKey || "",
        });

        this.apiKey = api.apiKey;
        this.graphQLUrl = api.graphqlUrl;
    }
}
