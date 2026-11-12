export type ChatStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';
/** Why a connection ended for good (it is not retried). */
export type ChatClosedWhy = 'banned' | 'forbidden' | 'unauthorized' | 'room_closed' | 'shutdown';
