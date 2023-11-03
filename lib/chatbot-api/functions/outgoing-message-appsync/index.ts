import {
    BatchProcessor,
    EventType,
    processPartialResponse,
  } from '@aws-lambda-powertools/batch';
  import { Logger } from '@aws-lambda-powertools/logger';
  import type {
    SQSEvent,
    SQSRecord,
    Context,
    SQSBatchResponse,
  } from 'aws-lambda';
  import { graphQlQuery } from './graphql';
 
  const processor = new BatchProcessor(EventType.SQS); 
  const logger = new Logger();
 
  const recordHandler = async (record: SQSRecord): Promise<void> => { 
    const payload = record.body;
    if (payload) {
      const item = JSON.parse(payload);
      logger.info('Processed item', { item });
      const req = JSON.parse(item.Message);
      /*
      payload: str = record.body
      message: dict = json.loads(payload)
      detail: dict = json.loads(message["Message"])
      logger.info(detail)
      user_id = detail["userId"]
      connection_id = detail["connectionId"]
      */

      const query = /* GraphQL */ `
        mutation Mutation {
          publishResponse (data: ${JSON.stringify(item.Message)}, sessionId: "${req.data.sessionId}") {
            data
            sessionId
          }
        }
    `;
      const resp = await graphQlQuery(query);
      logger.info(resp)
    }
  };
 

  export const handler = async (
    event: SQSEvent,
    context: Context
  ): Promise<SQSBatchResponse> => {
    return processPartialResponse(event, recordHandler, processor, { 
      context,
    });
  };
 