/* tslint:disable */
/* eslint-disable */
//  This file was automatically generated and should not be edited.

export type Channel = {
  __typename: "Channel",
  data?: string | null,
  sessionId?: string | null,
};

export type SendQueryMutationVariables = {
  data?: string | null,
};

export type SendQueryMutation = {
  sendQuery?: string | null,
};

export type PublishResponseMutationVariables = {
  sessionId?: string | null,
  data?: string | null,
};

export type PublishResponseMutation = {
  publishResponse?:  {
    __typename: "Channel",
    data?: string | null,
    sessionId?: string | null,
  } | null,
};

export type NoneQuery = {
  none?: string | null,
};

export type NoneQueryVariables = {
  none?: string | null,
};

export type ReceiveMessagesSubscriptionVariables = {
  sessionId?: string | null,
};

export type ReceiveMessagesSubscription = {
  receiveMessages?:  {
    __typename: "Channel",
    data?: string | null,
    sessionId?: string | null,
  } | null,
};
