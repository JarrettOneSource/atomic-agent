import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";

export interface InvokeContext {
  sender: IpcMainInvokeEvent["sender"];
}
export interface MessageContext extends InvokeContext {
  returnValue: unknown;
}
type InvokeHandler = (event: InvokeContext, ...args: unknown[]) => unknown;
type MessageHandler = (event: MessageContext, ...args: unknown[]) => void;

/** One set of application handlers for the native and browser transports. */
export class IpcBridge {
  private readonly calls = new Map<string, InvokeHandler>();
  private readonly messages = new Map<string, MessageHandler[]>();

  constructor(private readonly native: Pick<IpcMain, "handle" | "on">) {}

  handle(channel: string, handler: InvokeHandler): void {
    this.native.handle(channel, handler);
    this.calls.set(channel, handler);
  }

  on(channel: string, handler: MessageHandler): void {
    this.native.on(channel, handler);
    this.messages.set(channel, [...(this.messages.get(channel) ?? []), handler]);
  }

  async invoke(channel: string, args: unknown[], sender: WebContents): Promise<unknown> {
    const handler = this.calls.get(channel);
    if (!handler) throw new Error("Unknown application method");
    return handler({ sender }, ...args);
  }

  send(channel: string, args: unknown[], sender: WebContents): unknown {
    const handlers = this.messages.get(channel);
    if (!handlers) throw new Error("Unknown application message");
    const event: MessageContext = { sender, returnValue: undefined };
    for (const handler of handlers) handler(event, ...args);
    return event.returnValue;
  }
}
