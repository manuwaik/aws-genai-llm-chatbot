/* tslint:disable */
/* eslint-disable */
// this is an auto generated file. This will be overwritten

import * as APITypes from "../API";
type GeneratedMutation<InputType, OutputType> = string & {
  __generatedMutationInput: InputType;
  __generatedMutationOutput: OutputType;
};

export const sendQuery = /* GraphQL */ `mutation SendQuery($data: String) {
  sendQuery(data: $data)
}
` as GeneratedMutation<
  APITypes.SendQueryMutationVariables,
  APITypes.SendQueryMutation
>;
export const publishResponse =
  /* GraphQL */ `mutation PublishResponse($data: String) {
  publishResponse(data: $data)
}
` as GeneratedMutation<
    APITypes.PublishResponseMutationVariables,
    APITypes.PublishResponseMutation
  >;
