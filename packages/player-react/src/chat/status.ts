export type ChatStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';
/**
 * Why a connection ended for good (it is not retried). `not_found` is a 404 (the base URL or the route is wrong); `unsupported` is an
 * answer that is not an event stream (a captive portal, a single-page-app fallback, a proxy's page).
 */
export type ChatClosedWhy = 'banned' | 'forbidden' | 'unauthorized' | 'room_closed' | 'shutdown' | 'replaced' | 'not_found' | 'unsupported';
