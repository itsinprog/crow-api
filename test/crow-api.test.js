"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = require("aws-cdk-lib");
const apigateway = require("aws-cdk-lib/aws-apigateway");
const lambda = require("aws-cdk-lib/aws-lambda");
const logs = require("aws-cdk-lib/aws-logs");
const assertions_1 = require("aws-cdk-lib/assertions");
// import { assert } from 'console';
const CrowApi = require("../lib/crow-api-stack");
function getLogicalId(stack, resource) {
    return stack.getLogicalId(resource.node.findChild('Resource'));
}
function logicalIdFromResource(resource) {
    try {
        const resKeys = Object.keys(resource);
        if (resKeys.length !== 1) {
            throw new Error('Resource is not unique.');
        }
        const [logicalId] = resKeys;
        return logicalId;
    }
    catch (err) {
        console.log(resource);
        throw err;
    }
}
// This function would need work if there were path parts with the same name
function findApiGResourceByPath(template, path) {
    const resource = template.findResources('AWS::ApiGateway::Resource', {
        Properties: {
            PathPart: path,
        },
    });
    return logicalIdFromResource(resource);
}
describe('Successful creation', () => {
    const app = new cdk.App();
    const stack = new CrowApi.CrowApiStack(app, 'MyTestStack', {
        crowApiProps: {
            sourceDirectory: 'test/testsrc',
            apiGatewayConfiguration: {
                restApiName: 'testing-crow-api',
            },
            useAuthorizerLambda: true,
            authorizerLambdaConfiguration: {
                timeout: cdk.Duration.seconds(20),
            },
            tokenAuthorizerConfiguration: {
                validationRegex: '^Bearer [-_A-Za-z0-9+/.]+={0,2}$',
                resultsCacheTtl: cdk.Duration.seconds(300),
            },
            createApiKey: true,
            logRetention: logs.RetentionDays.TWO_MONTHS,
            lambdaConfigurations: {
                '/v1/authors/get': {
                    tracing: lambda.Tracing.ACTIVE,
                },
                '/v1/authors/post': {
                    timeout: cdk.Duration.seconds(10),
                },
                '/v1/book/get': {
                    environment: {
                        HELLO: 'WORLD',
                    },
                },
                '/v1/book/post': {
                    description: '/v1/book/post',
                },
                '/v1/chapters/get': {
                    memorySize: 1024,
                },
            },
            lambdaIntegrationOptions: {
                '/v1/book/get': {
                    requestParameters: {
                        'integration.request.querystring.author': 'method.request.querystring.author',
                    },
                },
            },
            models: [
                {
                    modelName: 'authorsPost',
                    schema: {
                        schema: apigateway.JsonSchemaVersion.DRAFT4,
                        title: '/v1/authors/post',
                        type: apigateway.JsonSchemaType.OBJECT,
                        required: ['name'],
                        properties: {
                            name: {
                                type: apigateway.JsonSchemaType.STRING,
                            },
                        },
                    },
                },
            ],
            requestValidators: [
                {
                    requestValidatorName: 'validateBody',
                    validateRequestBody: true,
                },
            ],
            methodConfigurations: {
                '/v1/authors/get': {},
                '/v1/authors/post': {
                    apiKeyRequired: true,
                    requestModels: {
                        'application/json': 'authorsPost',
                    },
                    requestValidator: 'validateBody',
                },
                '/v1/book/get': {
                    useAuthorizerLambda: true,
                    requestParameters: {
                        'method.request.querystring.author': true,
                    },
                },
                '/v1/book/post': {
                    apiKeyRequired: true,
                },
                '/v1/chapters/get': {
                    useAuthorizerLambda: true,
                },
            }
        },
    });
    const template = assertions_1.Template.fromStack(stack);
    const restApiLogicalId = getLogicalId(stack, stack.api.gateway);
    test('API Gateway created and apiGatewayConfiguration passed in', () => {
        template.hasResourceProperties('AWS::ApiGateway::RestApi', {
            Name: 'testing-crow-api',
        });
    });
    test('API Gateway Resources created', () => {
        template.hasResourceProperties('AWS::ApiGateway::Resource', {
            ParentId: {
                'Fn::GetAtt': [
                    restApiLogicalId,
                    'RootResourceId',
                ],
            },
            PathPart: 'v1',
            RestApiId: {
                Ref: restApiLogicalId,
            },
        });
        const v1LogicalId = findApiGResourceByPath(template, 'v1');
        template.hasResourceProperties('AWS::ApiGateway::Resource', {
            ParentId: {
                Ref: v1LogicalId,
            },
            PathPart: 'authors',
            RestApiId: {
                Ref: restApiLogicalId,
            },
        });
        template.hasResourceProperties('AWS::ApiGateway::Resource', {
            ParentId: {
                Ref: v1LogicalId,
            },
            PathPart: 'book',
            RestApiId: {
                Ref: restApiLogicalId,
            },
        });
        template.hasResourceProperties('AWS::ApiGateway::Resource', {
            ParentId: {
                Ref: v1LogicalId,
            },
            PathPart: 'chapters',
            RestApiId: {
                Ref: restApiLogicalId,
            },
        });
    });
    test('Lambda Functions created', () => {
        // /v1/authors/get
        template.findResources('AWS::Lambda::Function', {
            Properties: {
                TracingConfig: {
                    Mode: 'Active',
                },
            },
        });
        // /v1/authors/post
        template.findResources('AWS::Lambda::Function', {
            Properties: {
                Timeout: 10,
            },
        });
        // /v1/book/get
        template.findResources('AWS::Lambda::Function', {
            Properties: {
                Environment: {
                    Variables: {
                        HELLO: 'WORLD',
                    },
                },
            },
        });
        // /v1/book/post
        template.findResources('AWS::Lambda::Function', {
            Properties: {
                Description: '/v1/book/post',
            },
        });
        // /v1/chapters/get
        template.findResources('AWS::Lambda::Function', {
            Properties: {
                MemorySize: 1024,
            },
        });
        // Authorizer Lambda
        template.hasResourceProperties('AWS::Lambda::Function', {
            Timeout: 20,
        });
    });
    test('API Gateway Methods created and correctly mapped to Lambda Functions', () => {
        // Parent resource IDs
        const authorsLogicalId = findApiGResourceByPath(template, 'authors');
        const bookLogicalId = findApiGResourceByPath(template, 'book');
        const chaptersLogicalId = findApiGResourceByPath(template, 'chapters');
        // Find all Lambda Functions
        const v1AuthorsGetLambda = template.findResources('AWS::Lambda::Function', {
            Properties: {
                TracingConfig: {
                    Mode: 'Active',
                },
            },
        });
        const v1AuthorsPostLambda = template.findResources('AWS::Lambda::Function', {
            Properties: {
                Timeout: 10,
            },
        });
        const v1BookGetLambda = template.findResources('AWS::Lambda::Function', {
            Properties: {
                Environment: {
                    Variables: {
                        HELLO: 'WORLD',
                    },
                },
            },
        });
        const v1BookPostLambda = template.findResources('AWS::Lambda::Function', {
            Properties: {
                Description: '/v1/book/post',
            },
        });
        const v1ChaptersGetLambda = template.findResources('AWS::Lambda::Function', {
            Properties: {
                MemorySize: 1024,
            },
        });
        // Find Lambda Function Logical IDs
        const v1AuthorsGetLambdaLogicalId = logicalIdFromResource(v1AuthorsGetLambda);
        const v1AuthorsPostLambdaLogicalId = logicalIdFromResource(v1AuthorsPostLambda);
        const v1BookGetLambdaLogicalId = logicalIdFromResource(v1BookGetLambda);
        const v1BookPostLambdaLogicalId = logicalIdFromResource(v1BookPostLambda);
        const v1ChaptersGetLambdaLogicalId = logicalIdFromResource(v1ChaptersGetLambda);
        // Find Models
        const authorsPostModel = template.findResources('AWS::ApiGateway::Model', {
            Properties: {
                RestApiId: {
                    Ref: restApiLogicalId,
                },
                Name: 'authorsPost',
            },
        });
        const authorsPostModelLogicalId = logicalIdFromResource(authorsPostModel);
        // Find Validators
        const authorsPostValidator = template.findResources('AWS::ApiGateway::RequestValidator', {
            Properties: {
                RestApiId: {
                    Ref: restApiLogicalId,
                },
                Name: 'validateBody',
                ValidateRequestBody: true,
            },
        });
        const authorsPostValidatorLogicalId = logicalIdFromResource(authorsPostValidator);
        // Test that methods have the correct configuration passed down
        //   and are mapping to the correct Lambda
        template.hasResourceProperties('AWS::ApiGateway::Method', {
            HttpMethod: 'GET',
            ResourceId: {
                Ref: authorsLogicalId,
            },
            RestApiId: {
                Ref: restApiLogicalId,
            },
            Integration: {
                Uri: {
                    'Fn::Join': [
                        '',
                        [
                            'arn:',
                            { Ref: 'AWS::Partition' },
                            ':apigateway:',
                            { Ref: 'AWS::Region' },
                            ':lambda:path/2015-03-31/functions/',
                            {
                                'Fn::GetAtt': [
                                    v1AuthorsGetLambdaLogicalId,
                                    'Arn',
                                ],
                            },
                            '/invocations',
                        ],
                    ],
                },
            },
        });
        template.hasResourceProperties('AWS::ApiGateway::Method', {
            HttpMethod: 'POST',
            ResourceId: {
                Ref: authorsLogicalId,
            },
            RestApiId: {
                Ref: restApiLogicalId,
            },
            ApiKeyRequired: true,
            Integration: {
                Uri: {
                    'Fn::Join': [
                        '',
                        [
                            'arn:',
                            { Ref: 'AWS::Partition' },
                            ':apigateway:',
                            { Ref: 'AWS::Region' },
                            ':lambda:path/2015-03-31/functions/',
                            {
                                'Fn::GetAtt': [
                                    v1AuthorsPostLambdaLogicalId,
                                    'Arn',
                                ],
                            },
                            '/invocations',
                        ],
                    ],
                },
            },
            RequestModels: {
                'application/json': {
                    Ref: authorsPostModelLogicalId,
                },
            },
            RequestValidatorId: {
                Ref: authorsPostValidatorLogicalId,
            },
        });
        template.hasResourceProperties('AWS::ApiGateway::Method', {
            HttpMethod: 'GET',
            ResourceId: {
                Ref: bookLogicalId,
            },
            RestApiId: {
                Ref: restApiLogicalId,
            },
            AuthorizationType: 'CUSTOM',
            RequestParameters: {
                'method.request.querystring.author': true,
            },
            Integration: {
                Uri: {
                    'Fn::Join': [
                        '',
                        [
                            'arn:',
                            { Ref: 'AWS::Partition' },
                            ':apigateway:',
                            { Ref: 'AWS::Region' },
                            ':lambda:path/2015-03-31/functions/',
                            {
                                'Fn::GetAtt': [
                                    v1BookGetLambdaLogicalId,
                                    'Arn',
                                ],
                            },
                            '/invocations',
                        ],
                    ],
                },
                RequestParameters: {
                    'integration.request.querystring.author': 'method.request.querystring.author'
                }
            },
        });
        template.hasResourceProperties('AWS::ApiGateway::Method', {
            HttpMethod: 'POST',
            ResourceId: {
                Ref: bookLogicalId,
            },
            RestApiId: {
                Ref: restApiLogicalId,
            },
            ApiKeyRequired: true,
            Integration: {
                Uri: {
                    'Fn::Join': [
                        '',
                        [
                            'arn:',
                            { Ref: 'AWS::Partition' },
                            ':apigateway:',
                            { Ref: 'AWS::Region' },
                            ':lambda:path/2015-03-31/functions/',
                            {
                                'Fn::GetAtt': [
                                    v1BookPostLambdaLogicalId,
                                    'Arn',
                                ],
                            },
                            '/invocations',
                        ],
                    ],
                },
            },
        });
        template.hasResourceProperties('AWS::ApiGateway::Method', {
            HttpMethod: 'GET',
            ResourceId: {
                Ref: chaptersLogicalId,
            },
            RestApiId: {
                Ref: restApiLogicalId,
            },
            AuthorizationType: 'CUSTOM',
            Integration: {
                Uri: {
                    'Fn::Join': [
                        '',
                        [
                            'arn:',
                            { Ref: 'AWS::Partition' },
                            ':apigateway:',
                            { Ref: 'AWS::Region' },
                            ':lambda:path/2015-03-31/functions/',
                            {
                                'Fn::GetAtt': [
                                    v1ChaptersGetLambdaLogicalId,
                                    'Arn',
                                ],
                            },
                            '/invocations',
                        ],
                    ],
                },
            },
        });
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY3Jvdy1hcGkudGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNyb3ctYXBpLnRlc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSxtQ0FBbUM7QUFDbkMseURBQXlEO0FBQ3pELGlEQUFpRDtBQUNqRCw2Q0FBNkM7QUFDN0MsdURBQWtEO0FBQ2xELG9DQUFvQztBQUNwQyxpREFBaUQ7QUFFakQsU0FBUyxZQUFZLENBQUMsS0FBZ0IsRUFBRSxRQUF1QjtJQUM3RCxPQUFPLEtBQUssQ0FBQyxZQUFZLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsVUFBVSxDQUFtQixDQUFDLENBQUM7QUFDbkYsQ0FBQztBQUVELFNBQVMscUJBQXFCLENBQUMsUUFBYTtJQUMxQyxJQUFJO1FBQ0YsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUN0QyxJQUFJLE9BQU8sQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFO1lBQ3hCLE1BQU0sSUFBSSxLQUFLLENBQUMseUJBQXlCLENBQUMsQ0FBQztTQUM1QztRQUNELE1BQU0sQ0FBQyxTQUFTLENBQUMsR0FBRyxPQUFPLENBQUM7UUFDNUIsT0FBTyxTQUFTLENBQUM7S0FDbEI7SUFBQyxPQUFPLEdBQUcsRUFBRTtRQUNaLE9BQU8sQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDdEIsTUFBTSxHQUFHLENBQUM7S0FDWDtBQUNILENBQUM7QUFFRCw0RUFBNEU7QUFDNUUsU0FBUyxzQkFBc0IsQ0FBQyxRQUFrQixFQUFFLElBQVk7SUFDOUQsTUFBTSxRQUFRLEdBQUcsUUFBUSxDQUFDLGFBQWEsQ0FBQywyQkFBMkIsRUFBRTtRQUNuRSxVQUFVLEVBQUU7WUFDVixRQUFRLEVBQUUsSUFBSTtTQUNmO0tBQ0YsQ0FBQyxDQUFDO0lBQ0gsT0FBTyxxQkFBcUIsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUN6QyxDQUFDO0FBRUQsUUFBUSxDQUFD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QUNULEdBQUcsRUFBRSxnQkFBZ0I7YUFDdEI7WUFDRCxpQkFBaUIsRUFBRSxRQUFRO1lBQzNCLFdBQVcsRUFBRTtnQkFDWCxHQUFHLEVBQUU7b0JBQ0gsVUFBVSxFQUFFO3dCQUNWLEVBQUU7d0JBQ0Y7NEJBQ0UsTUFBTTs0QkFDTixFQUFFLEdBQUcsRUFBRSxnQkFBZ0IsRUFBRTs0QkFDekIsY0FBYzs0QkFDZCxFQUFFLEdBQUcsRUFBRSxhQUFhLEVBQUU7NEJBQ3RCLG9DQUFvQzs0QkFDcEM7Z0NBQ0UsWUFBWSxFQUFFO29DQUNaLDRCQUE0QjtvQ0FDNUIsS0FBSztpQ0FDTjs2QkFDRjs0QkFDRCxjQUFjO3lCQUNmO3FCQUNGO2lCQUNGO2FBQ0Y7U0FDRixDQUFDLENBQUM7SUFDTCxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXkgZnJvbSAnYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXknO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncyc7XG5pbXBvcnQgeyBUZW1wbGF0ZSB9IGZyb20gJ2F3cy1jZGstbGliL2Fzc2VydGlvbnMnO1xuLy8gaW1wb3J0IHsgYXNzZXJ0IH0gZnJvbSAnY29uc29sZSc7XG5pbXBvcnQgKiBhcyBDcm93QXBpIGZyb20gJy4uL2xpYi9jcm93LWFwaS1zdGFjayc7XG5cbmZ1bmN0aW9uIGdldExvZ2ljYWxJZChzdGFjazogY2RrLlN0YWNrLCByZXNvdXJjZTogY2RrLklSZXNvdXJjZSkge1xuICByZXR1cm4gc3RhY2suZ2V0TG9naWNhbElkKHJlc291cmNlLm5vZGUuZmluZENoaWxkKCdSZXNvdXJjZScpIGFzIGNkay5DZm5FbGVtZW50KTtcbn1cblxuZnVuY3Rpb24gbG9naWNhbElkRnJvbVJlc291cmNlKHJlc291cmNlOiBhbnkpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXNLZXlzID0gT2JqZWN0LmtleXMocmVzb3VyY2UpO1xuICAgIGlmIChyZXNLZXlzLmxlbmd0aCAhPT0gMSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdSZXNvdXJjZSBpcyBub3QgdW5pcXVlLicpO1xuICAgIH1cbiAgICBjb25zdCBbbG9naWNhbElkXSA9IHJlc0tleXM7XG4gICAgcmV0dXJuIGxvZ2ljYWxJZDtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc29sZS5sb2cocmVzb3VyY2UpO1xuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vLyBUaGlzIGZ1bmN0aW9uIHdvdWxkIG5lZWQgd29yayBpZiB0aGVyZSB3ZXJlIHBhdGggcGFydHMgd2l0aCB0aGUgc2FtZSBuYW1lXG5mdW5jdGlvbiBmaW5kQXBpR1Jlc291cmNlQnlQYXRoKHRlbXBsYXRlOiBUZW1wbGF0ZSwgcGF0aDogc3RyaW5nKSB7XG4gIGNvbnN0IHJlc291cmNlID0gdGVtcGxhdGUuZmluZFJlc291cmNlcygnQVdTOjpBcGlHYXRld2F5OjpSZXNvdXJjZScsIHtcbiAgICBQcm9wZXJ0aWVzOiB7XG4gICAgICBQYXRoUGFydDogcGF0aCxcbiAgICB9LFxuICB9KTtcbiAgcmV0dXJuIGxvZ2ljYWxJZEZyb21SZXNvdXJjZShyZXNvdXJjZSk7XG59XG5cbmRlc2NyaWJlKCdTdWNjZXNzZnVsIGNyZWF0aW9uJywgKCkgPT4ge1xuICBjb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuICBjb25zdCBzdGFjayA9IG5ldyBDcm93QXBpLkNyb3dBcGlTdGFjayhhcHAsICdNeVRlc3RTdGFjaycsIHtcbiAgICBjcm93QXBpUHJvcHM6IHtcbiAgICAgIHNvdXJjZURpcmVjdG9yeTogJ3Rlc3QvdGVzdHNyYycsXG4gICAgICBhcGlHYXRld2F5Q29uZmlndXJhdGlvbjoge1xuICAgICAgICByZXN0QXBpTmFtZTogJ3Rlc3RpbmctY3Jvdy1hcGknLFxuICAgICAgfSxcbiAgICAgIHVzZUF1dGhvcml6ZXJMYW1iZGE6IHRydWUsXG4gICAgICBhdXRob3JpemVyTGFtYmRhQ29uZmlndXJhdGlvbjoge1xuICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygyMCksXG4gICAgICB9LFxuICAgICAgdG9rZW5BdXRob3JpemVyQ29uZmlndXJhdGlvbjoge1xuICAgICAgICB2YWxpZGF0aW9uUmVnZXg6ICdeQmVhcmVyIFstX0EtWmEtejAtOSsvLl0rPXswLDJ9JCcsXG4gICAgICAgIHJlc3VsdHNDYWNoZVR0bDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzAwKSxcbiAgICAgIH0sXG4gICAgICBjcmVhdGVBcGlLZXk6IHRydWUsXG4gICAgICBsb2dSZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5UV09fTU9OVEhTLFxuICAgICAgbGFtYmRhQ29uZmlndXJhdGlvbnM6IHtcbiAgICAgICAgJy92MS9hdXRob3JzL2dldCc6IHtcbiAgICAgICAgICB0cmFjaW5nOiBsYW1iZGEuVHJhY2luZy5BQ1RJVkUsXG4gICAgICAgIH0sXG4gICAgICAgICcvdjEvYXV0aG9ycy9wb3N0Jzoge1xuICAgICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEwKSxcbiAgICAgICAgfSxcbiAgICAgICAgJy92MS9ib29rL2dldCc6IHtcbiAgICAgICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAgICAgSEVMTE86ICdXT1JMRCcsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgJy92MS9ib29rL3Bvc3QnOiB7XG4gICAgICAgICAgZGVzY3JpcHRpb246ICcvdjEvYm9vay9wb3N0JyxcbiAgICAgICAgfSxcbiAgICAgICAgJy92MS9jaGFwdGVycy9nZXQnOiB7XG4gICAgICAgICAgbWVtb3J5U2l6ZTogMTAyNCxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICBsYW1iZGFJbnRlZ3JhdGlvbk9wdGlvbnM6IHtcbiAgICAgICAgJy92MS9ib29rL2dldCc6IHtcbiAgICAgICAgICByZXF1ZXN0UGFyYW1ldGVyczoge1xuICAgICAgICAgICAgJ2ludGVncmF0aW9uLnJlcXVlc3QucXVlcnlzdHJpbmcuYXV0aG9yJzogJ21ldGhvZC5yZXF1ZXN0LnF1ZXJ5c3RyaW5nLmF1dGhvcicsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICBtb2RlbHM6IFtcbiAgICAgICAge1xuICAgICAgICAgIG1vZGVsTmFtZTogJ2F1dGhvcnNQb3N0JyxcbiAgICAgICAgICBzY2hlbWE6IHtcbiAgICAgICAgICAgIHNjaGVtYTogYXBpZ2F0ZXdheS5Kc29uU2NoZW1hVmVyc2lvbi5EUkFGVDQsXG4gICAgICAgICAgICB0aXRsZTogJy92MS9hdXRob3JzL3Bvc3QnLFxuICAgICAgICAgICAgdHlwZTogYXBpZ2F0ZXdheS5Kc29uU2NoZW1hVHlwZS5PQkpFQ1QsXG4gICAgICAgICAgICByZXF1aXJlZDogWyduYW1lJ10sXG4gICAgICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICAgIG5hbWU6IHtcbiAgICAgICAgICAgICAgICB0eXBlOiBhcGlnYXRld2F5Lkpzb25TY2hlbWFUeXBlLlNUUklORyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICByZXF1ZXN0VmFsaWRhdG9yczogW1xuICAgICAgICB7XG4gICAgICAgICAgcmVxdWVzdFZhbGlkYXRvck5hbWU6ICd2YWxpZGF0ZUJvZHknLFxuICAgICAgICAgIHZhbGlkYXRlUmVxdWVzdEJvZHk6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgbWV0aG9kQ29uZmlndXJhdGlvbnM6IHtcbiAgICAgICAgJy92MS9hdXRob3JzL2dldCc6IHt9LFxuICAgICAgICAnL3YxL2F1dGhvcnMvcG9zdCc6IHtcbiAgICAgICAgICBhcGlLZXlSZXF1aXJlZDogdHJ1ZSxcbiAgICAgICAgICByZXF1ZXN0TW9kZWxzOiB7XG4gICAgICAgICAgICAnYXBwbGljYXRpb24vanNvbic6ICdhdXRob3JzUG9zdCcsXG4gICAgICAgICAgfSxcbiAgICAgICAgICByZXF1ZXN0VmFsaWRhdG9yOiAndmFsaWRhdGVCb2R5JyxcbiAgICAgICAgfSxcbiAgICAgICAgJy92MS9ib29rL2dldCc6IHtcbiAgICAgICAgICB1c2VBdXRob3JpemVyTGFtYmRhOiB0cnVlLFxuICAgICAgICAgIHJlcXVlc3RQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICAnbWV0aG9kLnJlcXVlc3QucXVlcnlzdHJpbmcuYXV0aG9yJzogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICAnL3YxL2Jvb2svcG9zdCc6IHtcbiAgICAgICAgICBhcGlLZXlSZXF1aXJlZDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgICAgJy92MS9jaGFwdGVycy9nZXQnOiB7XG4gICAgICAgICAgdXNlQXV0aG9yaXplckxhbWJkYTogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgIH1cbiAgICB9LFxuICB9KTtcbiAgY29uc3QgdGVtcGxhdGUgPSBUZW1wbGF0ZS5mcm9tU3RhY2soc3RhY2spO1xuXG4gIGNvbnN0IHJlc3RBcGlMb2dpY2FsSWQgPSBnZXRMb2dpY2FsSWQoc3RhY2ssIHN0YWNrLmFwaS5nYXRld2F5KTtcblxuICB0ZXN0KCdBUEkgR2F0ZXdheSBjcmVhdGVkIGFuZCBhcGlHYXRld2F5Q29uZmlndXJhdGlvbiBwYXNzZWQgaW4nLCAoKSA9PiB7XG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwaUdhdGV3YXk6OlJlc3RBcGknLCB7XG4gICAgICBOYW1lOiAndGVzdGluZy1jcm93LWFwaScsXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ0FQSSBHYXRld2F5IFJlc291cmNlcyBjcmVhdGVkJywgKCkgPT4ge1xuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpBcGlHYXRld2F5OjpSZXNvdXJjZScsIHtcbiAgICAgIFBhcmVudElkOiB7XG4gICAgICAgICdGbjo6R2V0QXR0JzogW1xuICAgICAgICAgIHJlc3RBcGlMb2dpY2FsSWQsXG4gICAgICAgICAgJ1Jvb3RSZXNvdXJjZUlkJyxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgICBQYXRoUGFydDogJ3YxJyxcbiAgICAgIFJlc3RBcGlJZDoge1xuICAgICAgICBSZWY6IHJlc3RBcGlMb2dpY2FsSWQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgdjFMb2dpY2FsSWQgPSBmaW5kQXBpR1Jlc291cmNlQnlQYXRoKHRlbXBsYXRlLCAndjEnKTtcblxuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpBcGlHYXRld2F5OjpSZXNvdXJjZScsIHtcbiAgICAgIFBhcmVudElkOiB7XG4gICAgICAgIFJlZjogdjFMb2dpY2FsSWQsXG4gICAgICB9LFxuICAgICAgUGF0aFBhcnQ6ICdhdXRob3JzJyxcbiAgICAgIFJlc3RBcGlJZDoge1xuICAgICAgICBSZWY6IHJlc3RBcGlMb2dpY2FsSWQsXG4gICAgICB9LFxuICAgIH0pO1xuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpBcGlHYXRld2F5OjpSZXNvdXJjZScsIHtcbiAgICAgIFBhcmVudElkOiB7XG4gICAgICAgIFJlZjogdjFMb2dpY2FsSWQsXG4gICAgICB9LFxuICAgICAgUGF0aFBhcnQ6ICdib29rJyxcbiAgICAgIFJlc3RBcGlJZDoge1xuICAgICAgICBSZWY6IHJlc3RBcGlMb2dpY2FsSWQsXG4gICAgICB9LFxuICAgIH0pO1xuICAgIHRlbXBsYXRlLmhhc1Jlc291cmNlUHJvcGVydGllcygnQVdTOjpBcGlHYXRld2F5OjpSZXNvdXJjZScsIHtcbiAgICAgIFBhcmVudElkOiB7XG4gICAgICAgIFJlZjogdjFMb2dpY2FsSWQsXG4gICAgICB9LFxuICAgICAgUGF0aFBhcnQ6ICdjaGFwdGVycycsXG4gICAgICBSZXN0QXBpSWQ6IHtcbiAgICAgICAgUmVmOiByZXN0QXBpTG9naWNhbElkLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnTGFtYmRhIEZ1bmN0aW9ucyBjcmVhdGVkJywgKCkgPT4ge1xuICAgIC8vIC92MS9hdXRob3JzL2dldFxuICAgIHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoJ0FXUzo6TGFtYmRhOjpGdW5jdGlvbicsIHtcbiAgICAgIFByb3BlcnRpZXM6IHtcbiAgICAgICAgVHJhY2luZ0NvbmZpZzoge1xuICAgICAgICAgIE1vZGU6ICdBY3RpdmUnLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIC92MS9hdXRob3JzL3Bvc3RcbiAgICB0ZW1wbGF0ZS5maW5kUmVzb3VyY2VzKCdBV1M6OkxhbWJkYTo6RnVuY3Rpb24nLCB7XG4gICAgICBQcm9wZXJ0aWVzOiB7XG4gICAgICAgIFRpbWVvdXQ6IDEwLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIC92MS9ib29rL2dldFxuICAgIHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoJ0FXUzo6TGFtYmRhOjpGdW5jdGlvbicsIHtcbiAgICAgIFByb3BlcnRpZXM6IHtcbiAgICAgICAgRW52aXJvbm1lbnQ6IHtcbiAgICAgICAgICBWYXJpYWJsZXM6IHtcbiAgICAgICAgICAgIEhFTExPOiAnV09STEQnLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gL3YxL2Jvb2svcG9zdFxuICAgIHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoJ0FXUzo6TGFtYmRhOjpGdW5jdGlvbicsIHtcbiAgICAgICAgUHJvcGVydGllczoge1xuICAgICAgICAgIERlc2NyaXB0aW9uOiAnL3YxL2Jvb2svcG9zdCcsXG4gICAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyAvdjEvY2hhcHRlcnMvZ2V0XG4gICAgdGVtcGxhdGUuZmluZFJlc291cmNlcygnQVdTOjpMYW1iZGE6OkZ1bmN0aW9uJywge1xuICAgICAgUHJvcGVydGllczoge1xuICAgICAgICBNZW1vcnlTaXplOiAxMDI0LFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEF1dGhvcml6ZXIgTGFtYmRhXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkxhbWJkYTo6RnVuY3Rpb24nLCB7XG4gICAgICBUaW1lb3V0OiAyMCxcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdCgnQVBJIEdhdGV3YXkgTWV0aG9kcyBjcmVhdGVkIGFuZCBjb3JyZWN0bHkgbWFwcGVkIHRvIExhbWJkYSBGdW5jdGlvbnMnLCAoKSA9PiB7XG4gICAgLy8gUGFyZW50IHJlc291cmNlIElEc1xuICAgIGNvbnN0IGF1dGhvcnNMb2dpY2FsSWQgPSBmaW5kQXBpR1Jlc291cmNlQnlQYXRoKHRlbXBsYXRlLCAnYXV0aG9ycycpO1xuICAgIGNvbnN0IGJvb2tMb2dpY2FsSWQgPSBmaW5kQXBpR1Jlc291cmNlQnlQYXRoKHRlbXBsYXRlLCAnYm9vaycpO1xuICAgIGNvbnN0IGNoYXB0ZXJzTG9naWNhbElkID0gZmluZEFwaUdSZXNvdXJjZUJ5UGF0aCh0ZW1wbGF0ZSwgJ2NoYXB0ZXJzJyk7XG5cbiAgICAvLyBGaW5kIGFsbCBMYW1iZGEgRnVuY3Rpb25zXG4gICAgY29uc3QgdjFBdXRob3JzR2V0TGFtYmRhID0gdGVtcGxhdGUuZmluZFJlc291cmNlcygnQVdTOjpMYW1iZGE6OkZ1bmN0aW9uJywge1xuICAgICAgUHJvcGVydGllczoge1xuICAgICAgICBUcmFjaW5nQ29uZmlnOiB7XG4gICAgICAgICAgTW9kZTogJ0FjdGl2ZScsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGNvbnN0IHYxQXV0aG9yc1Bvc3RMYW1iZGEgPSB0ZW1wbGF0ZS5maW5kUmVzb3VyY2VzKCdBV1M6OkxhbWJkYTo6RnVuY3Rpb24nLCB7XG4gICAgICBQcm9wZXJ0aWVzOiB7XG4gICAgICAgIFRpbWVvdXQ6IDEwLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBjb25zdCB2MUJvb2tHZXRMYW1iZGEgPSB0ZW1wbGF0ZS5maW5kUmVzb3VyY2VzKCdBV1M6OkxhbWJkYTo6RnVuY3Rpb24nLCB7XG4gICAgICBQcm9wZXJ0aWVzOiB7XG4gICAgICAgIEVudmlyb25tZW50OiB7XG4gICAgICAgICAgVmFyaWFibGVzOiB7XG4gICAgICAgICAgICBIRUxMTzogJ1dPUkxEJyxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBjb25zdCB2MUJvb2tQb3N0TGFtYmRhID0gdGVtcGxhdGUuZmluZFJlc291cmNlcygnQVdTOjpMYW1iZGE6OkZ1bmN0aW9uJywge1xuICAgICAgICBQcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgRGVzY3JpcHRpb246ICcvdjEvYm9vay9wb3N0JyxcbiAgICAgICAgfSxcbiAgICB9KTtcbiAgICBjb25zdCB2MUNoYXB0ZXJzR2V0TGFtYmRhID0gdGVtcGxhdGUuZmluZFJlc291cmNlcygnQVdTOjpMYW1iZGE6OkZ1bmN0aW9uJywge1xuICAgICAgUHJvcGVydGllczoge1xuICAgICAgICBNZW1vcnlTaXplOiAxMDI0LFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEZpbmQgTGFtYmRhIEZ1bmN0aW9uIExvZ2ljYWwgSURzXG4gICAgY29uc3QgdjFBdXRob3JzR2V0TGFtYmRhTG9naWNhbElkID0gbG9naWNhbElkRnJvbVJlc291cmNlKHYxQXV0aG9yc0dldExhbWJkYSk7XG4gICAgY29uc3QgdjFBdXRob3JzUG9zdExhbWJkYUxvZ2ljYWxJZCA9IGxvZ2ljYWxJZEZyb21SZXNvdXJjZSh2MUF1dGhvcnNQb3N0TGFtYmRhKTtcbiAgICBjb25zdCB2MUJvb2tHZXRMYW1iZGFMb2dpY2FsSWQgPSBsb2dpY2FsSWRGcm9tUmVzb3VyY2UodjFCb29rR2V0TGFtYmRhKTtcbiAgICBjb25zdCB2MUJvb2tQb3N0TGFtYmRhTG9naWNhbElkID0gbG9naWNhbElkRnJvbVJlc291cmNlKHYxQm9va1Bvc3RMYW1iZGEpO1xuICAgIGNvbnN0IHYxQ2hhcHRlcnNHZXRMYW1iZGFMb2dpY2FsSWQgPSBsb2dpY2FsSWRGcm9tUmVzb3VyY2UodjFDaGFwdGVyc0dldExhbWJkYSk7XG5cbiAgICAvLyBGaW5kIE1vZGVsc1xuICAgIGNvbnN0IGF1dGhvcnNQb3N0TW9kZWwgPSB0ZW1wbGF0ZS5maW5kUmVzb3VyY2VzKCdBV1M6OkFwaUdhdGV3YXk6Ok1vZGVsJywge1xuICAgICAgUHJvcGVydGllczoge1xuICAgICAgICBSZXN0QXBpSWQ6IHtcbiAgICAgICAgICBSZWY6IHJlc3RBcGlMb2dpY2FsSWQsXG4gICAgICAgIH0sXG4gICAgICAgIE5hbWU6ICdhdXRob3JzUG9zdCcsXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGNvbnN0IGF1dGhvcnNQb3N0TW9kZWxMb2dpY2FsSWQgPSBsb2dpY2FsSWRGcm9tUmVzb3VyY2UoYXV0aG9yc1Bvc3RNb2RlbCk7XG5cbiAgICAvLyBGaW5kIFZhbGlkYXRvcnNcbiAgICBjb25zdCBhdXRob3JzUG9zdFZhbGlkYXRvciA9IHRlbXBsYXRlLmZpbmRSZXNvdXJjZXMoJ0FXUzo6QXBpR2F0ZXdheTo6UmVxdWVzdFZhbGlkYXRvcicsIHtcbiAgICAgIFByb3BlcnRpZXM6IHtcbiAgICAgICAgUmVzdEFwaUlkOiB7XG4gICAgICAgICAgUmVmOiByZXN0QXBpTG9naWNhbElkLFxuICAgICAgICB9LFxuICAgICAgICBOYW1lOiAndmFsaWRhdGVCb2R5JyxcbiAgICAgICAgVmFsaWRhdGVSZXF1ZXN0Qm9keTogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY29uc3QgYXV0aG9yc1Bvc3RWYWxpZGF0b3JMb2dpY2FsSWQgPSBsb2dpY2FsSWRGcm9tUmVzb3VyY2UoYXV0aG9yc1Bvc3RWYWxpZGF0b3IpO1xuXG4gICAgLy8gVGVzdCB0aGF0IG1ldGhvZHMgaGF2ZSB0aGUgY29ycmVjdCBjb25maWd1cmF0aW9uIHBhc3NlZCBkb3duXG4gICAgLy8gICBhbmQgYXJlIG1hcHBpbmcgdG8gdGhlIGNvcnJlY3QgTGFtYmRhXG4gICAgdGVtcGxhdGUuaGFzUmVzb3VyY2VQcm9wZXJ0aWVzKCdBV1M6OkFwaUdhdGV3YXk6Ok1ldGhvZCcsIHtcbiAgICAgIEh0dHBNZXRob2Q6ICdHRVQnLFxuICAgICAgUmVzb3VyY2VJZDoge1xuICAgICAgICBSZWY6IGF1dGhvcnNMb2dpY2FsSWQsXG4gICAgICB9LFxuICAgICAgUmVzdEFwaUlkOiB7XG4gICAgICAgIFJlZjogcmVzdEFwaUxvZ2ljYWxJZCxcbiAgICAgIH0sXG4gICAgICBJbnRlZ3JhdGlvbjoge1xuICAgICAgICBVcmk6IHtcbiAgICAgICAgICAnRm46OkpvaW4nOiBbXG4gICAgICAgICAgICAnJyxcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgJ2FybjonLFxuICAgICAgICAgICAgICB7IFJlZjogJ0FXUzo6UGFydGl0aW9uJyB9LFxuICAgICAgICAgICAgICAnOmFwaWdhdGV3YXk6JyxcbiAgICAgICAgICAgICAgeyBSZWY6ICdBV1M6OlJlZ2lvbicgfSxcbiAgICAgICAgICAgICAgJzpsYW1iZGE6cGF0aC8yMDE1LTAzLTMxL2Z1bmN0aW9ucy8nLFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgJ0ZuOjpHZXRBdHQnOiBbXG4gICAgICAgICAgICAgICAgICB2MUF1dGhvcnNHZXRMYW1iZGFMb2dpY2FsSWQsXG4gICAgICAgICAgICAgICAgICAnQXJuJyxcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAnL2ludm9jYXRpb25zJyxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBpR2F0ZXdheTo6TWV0aG9kJywge1xuICAgICAgSHR0cE1ldGhvZDogJ1BPU1QnLFxuICAgICAgUmVzb3VyY2VJZDoge1xuICAgICAgICBSZWY6IGF1dGhvcnNMb2dpY2FsSWQsXG4gICAgICB9LFxuICAgICAgUmVzdEFwaUlkOiB7XG4gICAgICAgIFJlZjogcmVzdEFwaUxvZ2ljYWxJZCxcbiAgICAgIH0sXG4gICAgICBBcGlLZXlSZXF1aXJlZDogdHJ1ZSxcbiAgICAgIEludGVncmF0aW9uOiB7XG4gICAgICAgIFVyaToge1xuICAgICAgICAgICdGbjo6Sm9pbic6IFtcbiAgICAgICAgICAgICcnLFxuICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAnYXJuOicsXG4gICAgICAgICAgICAgIHsgUmVmOiAnQVdTOjpQYXJ0aXRpb24nIH0sXG4gICAgICAgICAgICAgICc6YXBpZ2F0ZXdheTonLFxuICAgICAgICAgICAgICB7IFJlZjogJ0FXUzo6UmVnaW9uJyB9LFxuICAgICAgICAgICAgICAnOmxhbWJkYTpwYXRoLzIwMTUtMDMtMzEvZnVuY3Rpb25zLycsXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAnRm46OkdldEF0dCc6IFtcbiAgICAgICAgICAgICAgICAgIHYxQXV0aG9yc1Bvc3RMYW1iZGFMb2dpY2FsSWQsXG4gICAgICAgICAgICAgICAgICAnQXJuJyxcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAnL2ludm9jYXRpb25zJyxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICBSZXF1ZXN0TW9kZWxzOiB7XG4gICAgICAgICdhcHBsaWNhdGlvbi9qc29uJzoge1xuICAgICAgICAgIFJlZjogYXV0aG9yc1Bvc3RNb2RlbExvZ2ljYWxJZCxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICBSZXF1ZXN0VmFsaWRhdG9ySWQ6IHtcbiAgICAgICAgUmVmOiBhdXRob3JzUG9zdFZhbGlkYXRvckxvZ2ljYWxJZCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBpR2F0ZXdheTo6TWV0aG9kJywge1xuICAgICAgSHR0cE1ldGhvZDogJ0dFVCcsXG4gICAgICBSZXNvdXJjZUlkOiB7XG4gICAgICAgIFJlZjogYm9va0xvZ2ljYWxJZCxcbiAgICAgIH0sXG4gICAgICBSZXN0QXBpSWQ6IHtcbiAgICAgICAgUmVmOiByZXN0QXBpTG9naWNhbElkLFxuICAgICAgfSxcbiAgICAgIEF1dGhvcml6YXRpb25UeXBlOiAnQ1VTVE9NJyxcbiAgICAgIFJlcXVlc3RQYXJhbWV0ZXJzOiB7XG4gICAgICAgICdtZXRob2QucmVxdWVzdC5xdWVyeXN0cmluZy5hdXRob3InOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIEludGVncmF0aW9uOiB7XG4gICAgICAgIFVyaToge1xuICAgICAgICAgICdGbjo6Sm9pbic6IFtcbiAgICAgICAgICAgICcnLFxuICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAnYXJuOicsXG4gICAgICAgICAgICAgIHsgUmVmOiAnQVdTOjpQYXJ0aXRpb24nIH0sXG4gICAgICAgICAgICAgICc6YXBpZ2F0ZXdheTonLFxuICAgICAgICAgICAgICB7IFJlZjogJ0FXUzo6UmVnaW9uJyB9LFxuICAgICAgICAgICAgICAnOmxhbWJkYTpwYXRoLzIwMTUtMDMtMzEvZnVuY3Rpb25zLycsXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAnRm46OkdldEF0dCc6IFtcbiAgICAgICAgICAgICAgICAgIHYxQm9va0dldExhbWJkYUxvZ2ljYWxJZCxcbiAgICAgICAgICAgICAgICAgICdBcm4nLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICcvaW52b2NhdGlvbnMnLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgICBSZXF1ZXN0UGFyYW1ldGVyczoge1xuICAgICAgICAgICdpbnRlZ3JhdGlvbi5yZXF1ZXN0LnF1ZXJ5c3RyaW5nLmF1dGhvcic6ICdtZXRob2QucmVxdWVzdC5xdWVyeXN0cmluZy5hdXRob3InXG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBpR2F0ZXdheTo6TWV0aG9kJywge1xuICAgICAgSHR0cE1ldGhvZDogJ1BPU1QnLFxuICAgICAgUmVzb3VyY2VJZDoge1xuICAgICAgICBSZWY6IGJvb2tMb2dpY2FsSWQsXG4gICAgICB9LFxuICAgICAgUmVzdEFwaUlkOiB7XG4gICAgICAgIFJlZjogcmVzdEFwaUxvZ2ljYWxJZCxcbiAgICAgIH0sXG4gICAgICBBcGlLZXlSZXF1aXJlZDogdHJ1ZSxcbiAgICAgIEludGVncmF0aW9uOiB7XG4gICAgICAgIFVyaToge1xuICAgICAgICAgICdGbjo6Sm9pbic6IFtcbiAgICAgICAgICAgICcnLFxuICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAnYXJuOicsXG4gICAgICAgICAgICAgIHsgUmVmOiAnQVdTOjpQYXJ0aXRpb24nIH0sXG4gICAgICAgICAgICAgICc6YXBpZ2F0ZXdheTonLFxuICAgICAgICAgICAgICB7IFJlZjogJ0FXUzo6UmVnaW9uJyB9LFxuICAgICAgICAgICAgICAnOmxhbWJkYTpwYXRoLzIwMTUtMDMtMzEvZnVuY3Rpb25zLycsXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAnRm46OkdldEF0dCc6IFtcbiAgICAgICAgICAgICAgICAgIHYxQm9va1Bvc3RMYW1iZGFMb2dpY2FsSWQsXG4gICAgICAgICAgICAgICAgICAnQXJuJyxcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAnL2ludm9jYXRpb25zJyxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICB0ZW1wbGF0ZS5oYXNSZXNvdXJjZVByb3BlcnRpZXMoJ0FXUzo6QXBpR2F0ZXdheTo6TWV0aG9kJywge1xuICAgICAgSHR0cE1ldGhvZDogJ0dFVCcsXG4gICAgICBSZXNvdXJjZUlkOiB7XG4gICAgICAgIFJlZjogY2hhcHRlcnNMb2dpY2FsSWQsXG4gICAgICB9LFxuICAgICAgUmVzdEFwaUlkOiB7XG4gICAgICAgIFJlZjogcmVzdEFwaUxvZ2ljYWxJZCxcbiAgICAgIH0sXG4gICAgICBBdXRob3JpemF0aW9uVHlwZTogJ0NVU1RPTScsXG4gICAgICBJbnRlZ3JhdGlvbjoge1xuICAgICAgICBVcmk6IHtcbiAgICAgICAgICAnRm46OkpvaW4nOiBbXG4gICAgICAgICAgICAnJyxcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgJ2FybjonLFxuICAgICAgICAgICAgICB7IFJlZjogJ0FXUzo6UGFydGl0aW9uJyB9LFxuICAgICAgICAgICAgICAnOmFwaWdhdGV3YXk6JyxcbiAgICAgICAgICAgICAgeyBSZWY6ICdBV1M6OlJlZ2lvbicgfSxcbiAgICAgICAgICAgICAgJzpsYW1iZGE6cGF0aC8yMDE1LTAzLTMxL2Z1bmN0aW9ucy8nLFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgJ0ZuOjpHZXRBdHQnOiBbXG4gICAgICAgICAgICAgICAgICB2MUNoYXB0ZXJzR2V0TGFtYmRhTG9naWNhbElkLFxuICAgICAgICAgICAgICAgICAgJ0FybicsXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgJy9pbnZvY2F0aW9ucycsXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICB9KTtcbn0pO1xuIl19