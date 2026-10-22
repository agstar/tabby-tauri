import { Agent, request, get } from './http'

export class Server {}
export class Socket {}
export class TLSSocket extends Socket {}

export const globalAgent = new Agent()
export { Agent, request, get }
export default { Agent, request, get, globalAgent, Server, Socket, TLSSocket }
