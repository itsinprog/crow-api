# Crow API

Crow API lets you build an API intuitively based on the file structure of a project. Provide API Gateway and Lambda function configurations and crow will build out the appropriate paths and methods to the API Gateway. All created resources are available after initialization. `lambdaFunctions` will expose all Lambda functions created for further operations like adding environment variables and providing permissions.

| `crow-api` version | `aws-cdk` version | Notes                   |
| ------------------ | ----------------- | ----------------------- |
| 0                  | 1                 |                         |
| 1                  | 2                 | Not recommended for use |
| 2                  | 2                 |                         |

Contents:
- [Getting Started](#getting-started)
- [Example File Structure](#example-file-structure)
- [Crow API Props](#crow-api-props)
  - [`sourceDirectory`](#sourcedirectory)
  - [`sharedDirectory`](#shareddirectory)
  - [`useAuthorizerLambda`](#useauthorizerlambda)
  - [`authorizerDirectory`](#authorizerdirectory)
  - [`authorizerLambdaConfiguration`](#authorizerlambdaconfiguration)
  - [`tokenAuthorizerConfiguration`](#tokenauthorizerconfiguration)
  - [`createApiKey`](#createapikey)
  - [`logRetention`](#logretention)
  - [`apiGatewayName`](#apigatewayname)
  - [`apiGatewayConfiguration`](#apigatewayconfiguration)
  - [`lambdaConfigurations`](#lambdaconfigurations)
  - [`methodConfigurations`](#methodconfigurations)
  - [`models`](#models)
  - [`requestValidators`](#requestValidators)
- [Properties](#properties)
  - [`authorizerLambda`](#authorizerlambda)
  - [`gateway`](#gateway)
  - [`lambdaLayer`](#lambdalayer)
  - [`lambdaFunctions`](#lambdafunctions)
  - [`models`](#models)
  - [`requestValidators`](#requestValidators)

## Getting Started

[Start your application as a normal CDK app](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html)

```sh
npm install -g aws-cdk
cdk bootstrap # If this is your first cdk app, you will need to bootstrap your AWS account
cdk init app --language typescript
```

Next, install the Crow API package

```sh
npm install --save crow-api
```

In the `lib/` folder generated by the `cdk`, there should be a single file named `<your-app>-stack.js`. Create your Crow API construct inside of that file like so

```typescript
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CrowApi, ICrowApiProps } from 'crow-api';

interface IYourAppStackProps extends StackProps {
  crowApiProps: ICrowApiProps,
}

export class YourAppStack extends Stack {
  constructor(scope: Construct, id: string, props: IYourAppStackProps) {
    super(scope, id, props);

    const {
      crowApiProps,
    } = props;

    const api = new CrowApi(this, 'api', {
      ...crowApiProps,
    });
  }
}
```

Your API will start to take shape as you create folders to define paths and methods (see Example File Structure below). To deploy your API, simply run `cdk synth` and `cdk deploy`. Follow the instructions as they are prompted, and you will end up receiving a URL where your API now lives.

## Example File Structure
```
|-- src/
    |-- authorizer/
        |-- index.js
    |-- v1/
        |-- book/
            |-- get/
                |-- index.js
            |-- post/
                |-- index.js
        |-- chapters/
            |-- get/
                |-- index.js
        |-- authors/
            |-- get/
                |-- index.js
            |-- post/
                |-- index.js
```

The preceding file structure will create an API with the following routes:
- GET /v1/book
- POST /v1/book
- GET /v1/book/chapters
- GET /v1/authors
- POST /v1/authors

There needs to be an `index.js` file inside of a folder named after an HTTP method in order for a path to be created. The `index.js` file needs to export a `handler` method that will process the payload and return like the following.

```javascript
exports.handler = async function (event, context, callback) {
  try {
    const data = {
      statusCode: 201,
    };
    return data;
  } catch (uncaughtError) {
    console.error(uncaughtError);
    throw uncaughtError;
  }
}
```

## Crow API Props

Crow API takes in a few props to help you customize away from defaults.

#### `sourceDirectory`

By default, Crow walks through the `src` directory in the root of the repository to determine routes and methods, but you can change the top level directory by passing in the `sourceDirectory` prop. The string passed in should not start with or end with a slash (`/`). For example, `src`, `api/src`, or `source` are all valid options to pass in through that prop.

#### `sharedDirectory`

By default, Crow creates a Lambda layer out of the `shared` directory in the source directory of the repository, but you can change the name of the shared directory by passing in the `sharedDirectory` prop. The string passed in should not start with or end with a slash (`/`) and must be a direct child of the source directory. For example, `common` or `utils` are valid but `shared/utils` is not.

The Lambda layer created will be prepended to any the of the layers passed in through `lambdaConfigurations` and added to all Lambda functions created.

#### `useAuthorizerLambda`

Crow will create and attach an authorizer Lambda to specific methods if requested. The `useAuthorizerLambda` prop tells the `CrowApi` Construct that it should create an authorizer Lambda and accepts a boolean value. This is `false` by default.

#### `authorizerDirectory`

Crow will allow for a Lambda authorizer to be created and used by specific methods if requested. The `authorizerDirectory` prop tells Crow where to find the code for the Lambda authorizer **within the source directory which can be specified in the `sourceDirectory` prop**. It expects to find an `index.js` file that exports a `handler` function within the `authorizerDirectory`.

By default, Crow expects to find a directory called `src/authorizer` containing the authorizer Lambda source if the `useAuthorizerLambda` prop is `true`. If a different directory within the source directory should be looked at for this code, it should be specified by passing in a string to the `authorizerDirectory` prop. The string passed in should not start with nor end with a slash (`/`). For example, `auth` or `authLambdaSrc` are valid.

#### `authorizerLambdaConfiguration`

The `authorizerLambdaConfiguration` prop is passed directly to the Lambda functions which will be in charge of your API's authorization. The configuration allowed is exactly the same as the [Lambda Function props](https://docs.aws.amazon.com/cdk/api/v2//docs/aws-cdk-lib.aws_lambda.Function.html).

#### `tokenAuthorizerConfiguration`

The `tokenAuthorizerConfiguration` prop is passed directly to the `APIGateway.TokenAuthorizer` construct which will be in charge of your API's authorization. Anything available in the [class constructor for the `TokenAuthorizer`](https://docs.aws.amazon.com/cdk/api/v2//docs/aws-cdk-lib.aws_apigateway.TokenAuthorizer.html) can be overridden.

**Note:**

Be careful with this configuration item as all configuration here takes precedence over Crow defaults. I suggest not using this configuration item unless you are experienced with the AWS CDK, API Gateway, and Lambda.


#### `createApiKey`

By default, Crow does not create an API key associated with the API. If an API key is desired, pass in the `createApiKey` prop as `true`.

#### `logRetention`

By default, Crow creates log groups for resources it creates and sets the log retention to one week. If a different retention is desired pass in the `logRetention` prop of [enum type `RetentionDays`](https://docs.aws.amazon.com/cdk/api/v2//docs/aws-cdk-lib.aws_logs.RetentionDays.html).

#### `apiGatewayConfiguration`

This props allows for more complex overrides to the API Gateway that fronts your API. The configuration allowed is exactly the same as the [RestApi props](https://docs.aws.amazon.com/cdk/api/v2//docs/aws-cdk-lib.aws_apigateway.RestApi.html).

**Note:**

Be careful with this configuration item as all configuration here takes precedence over Crow defaults. I suggest not using this configuration item unless you are experienced with the AWS CDK and API Gateway.

An example of this prop might look like the following:

```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { CrowApiStack } from '../lib/crow-api-stack';

const devEnvironment = {
  account: '123456789012',
  region: 'us-east-1',
};

const app = new cdk.App();

new CrowApiStack(app, 'CrowApiStack', {
  env: devEnvironment,
  apiGatewayConfiguration: {
    endpointConfiguration: {
      types: [apigateway.EndpointType.REGIONAL],
    },
  },
});
```

#### `apiGatewayName`

This is a simple prop that names the API Gateway. This is how the API will be identified in the AWS console. The value should be a string without spaces and defaults to `crow-api`.

#### `lambdaConfigurations`

This props allows for more complex overrides to Lambda functions. The prop is an object with keys corresponding to the API path of a Lambda function and a value corresponding to the configuration that should be applied to the Lambda. The configuration allowed is exactly the same as the [Lambda Function props](https://docs.aws.amazon.com/cdk/api/v2//docs/aws-cdk-lib.aws_lambda.Function.html).

**Note:**

Be careful with this configuration item as all configuration here takes precedence over Crow defaults. I suggest not using this configuration item unless you are experienced with the AWS CDK and Lambda.

An example of this prop might look like the following:

```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CrowApiStack } from '../lib/crow-api-stack';

const devEnvironment = {
  account: '123456789012',
  region: 'us-east-1',
};

const app = new cdk.App();

new CrowApiStack(app, 'CrowApiStack', {
  env: devEnvironment,
  lambdaConfigurations: {
    '/v1/book/get': {
      timeout: cdk.Duration.seconds(5),
    },
  },
});
```

#### `methodConfigurations`

This prop allows for more complex overrides to individual methods. The prop is an object with keys corresponding to the API path of a method and a value corresponding to the configuration that should be applied to the method as well as the key `useAuthorizerLambda` which will invoke the authorizer Lambda whenever the method is called. The configuration allowed is almost exactly the same as [`MethodOptions`](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_apigateway.MethodOptions.html) plus the `useAuthorizerLambda` boolean.

The differences between `MethodOptions` and Crow's `CrowMethodConfiguration` (the type for this prop) is that any value referencing `{ [string]: IModel }` (`MethodOptions.requestModels` and `MethodResponse.responseModels`) has been changed to `{ [string]: string }` and similarly `requestValidator` has been changed from `IRequestValidator` to `string`. The strings that are passed should correspond with the `modelName`s or `requestValidatorName`s used in the [`models`](#models) and [`requestValidators`](#requestvalidators) props (see next sections).

**Note:**

If `createApiKey` is `true`, then the `apiKeyRequired` parameter will need to be set for the methods needing the API key.

An example of this prop might look like the following:

```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CrowApiStack } from '../lib/crow-api-stack';

const devEnvironment = {
  account: '123456789012',
  region: 'us-east-1',
};

const app = new cdk.App();

new CrowApiStack(app, 'CrowApiStack', {
  env: devEnvironment,
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
  methodConfigurations: {
    '/v1/authors/post': {
      apiKeyRequired: true,
      requestModels: {
        'application/json': 'authorsPost',
      },
    },
    '/v1/book/get': {
      useAuthorizerLambda: true,
    },
    '/v1/book/post': {
      apiKeyRequired: true,
    },
  },
});
```

#### `models`

This prop helps set up the `Model`s used in `methodConfiguration` above. It is an array of `CrowModelOptions` which are the same as [`MethodOptions`](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_apigateway.ModelOptions.html) except that the `modelName` is required. The `Model`s will receive an ID equal to its `modelName` which is why that prop is required. The `IModel` can then be referenced in `methodConfigurations` using its `modelName`.

#### `requestValidators`

This prop helps set up the `RequestValidator`s used in `methodConfiguration` above. It is an array of `CrowRequestValidatorOptions` which are the same as [`RequestValidatorOptions`](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_apigateway.RequestValidatorOptions.html) except that the `requestValidatorName` is required. The `RequestValidator`s will receive an ID equal to its `requestValidatorName` which is why that prop is required. The `IRequestValidator` can then be referenced in `methodConfigurations` using its `requestValidatorName`.

## Properties

A `CrowApi` construct will give full access to all of the resources it created.

#### `authorizerLambda`
This is the `lambda.Function` that authorizes API Gateway requests.

#### `gateway`
This is the `apigateway.RestApi` that all of the created Lambda functions sit behind.

#### `lambdaLayer`
If the `sharedDirectory` is populated, this is the `lambda.LayerVersion` created for that code. If the `sharedDirectory` is not populated, then this is `undefined`.

#### `lambdaFunctions`
This is an object with keys being the API paths and the values being the `lambda.Function`s sitting being them. Continuing off of the example file structure from above, the following would be an example of referencing `GET` `/v1/book/chapters`.

```typescript
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CrowApi, ICrowApiProps } from 'crow-api';

interface IYourAppStackProps extends StackProps {
  crowApiProps: ICrowApiProps,
}

export class YourAppStack extends Stack {
  constructor(scope: Construct, id: string, props: IYourAppStackProps) {
    super(scope, id, props);

    const {
      crowApiProps,
    } = props;

    const api = new CrowApi(this, 'api', {
      ...crowApiProps,
    });

    const lambda = api.lambdaFunctions['/v1/book/chapters/get'];
    lambda.addEnvironment('FOO', 'bar');
  }
}
```

#### `models`

This is an object with keys being the `modelName`s and values being the `IModel`s created.

#### `requestValidators`

This is an object with keys being the `requestValidatorName`s and values being the `IRequestValidator`s created.
