declare module 'ovh' {
  export interface OvhParams {
    endpoint: string;
    appKey: string;
    appSecret: string;
    consumerKey: string;
    timeout?: number;
  }

  export interface OvhClient {
    request(
      method: string,
      path: string,
      params?: any,
      callback?: (err: any, result: any) => void
    ): void;
    
    // Some versions might expose this, but we'll implement our own wrapper
    requestPromised?(method: string, path: string, params?: any): Promise<any>;
  }

  function ovh(params: OvhParams): OvhClient;
  export default ovh;
}
