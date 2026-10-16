// Ambient names the browser scripts share. There is no bundler: each file attaches its API to `window` (UMD), and the
// same files load in Node for the unit tests (hence `global`).
declare var global: typeof globalThis;
interface Window {
  /** Local development only: point the client at another API origin (default: same-origin `/api`). */
  WHICHPART_API_BASE?: string;
  ACChatSession: any;
  ACWebMCP?: any;
  turnstile?: any;
  TacLogic?: any;
}
interface Document { modelContext?: any }
interface Navigator { standalone?: boolean }
