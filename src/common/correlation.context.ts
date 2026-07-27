/* eslint-disable @typescript-eslint/no-unsafe-return */
import { AsyncLocalStorage } from 'async_hooks';

export class CorrelationContext {
  private static readonly storage = new AsyncLocalStorage<Map<string, any>>();

  public static run<R>(context: Map<string, any>, fn: () => R): R {
    return this.storage.run(context, fn);
  }

  public static getCorrelationId(): string | undefined {
    const store = this.storage.getStore();
    return store?.get('correlationId');
  }

  public static set(key: string, value: any): void {
    const store = this.storage.getStore();
    if (store) {
      store.set(key, value);
    }
  }

  public static get(key: string): any {
    const store = this.storage.getStore();
    return store?.get(key);
  }
}
