#!/usr/bin/env bash
# The five core calls of the service API, top to bottom, with curl: seat a player, check a line, report a player, ask for a player's notices and ask what they are restricted from (and the
# doors check a game runs at login). conformance.mjs is this script as a Node script that fails on any surprise.
#
#   BASE=http://127.0.0.1:8787 KEY=<a service key> bash examples/service/curl.sh
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:8787}"
KEY="${KEY:?set KEY to one of the service keys}"
ROOM="curl-$(date +%s)"
call() { curl -sS -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" "$@"; echo; }

echo "1. seat two players (the game keeps the seats; the service forgets them on a restart)"
call -X PUT "$BASE/v1/rooms/$ROOM/seats/alice" -d '{"who":{"clientKey":"curl-alice-key"},"handle":"alice"}'
call -X PUT "$BASE/v1/rooms/$ROOM/seats/bob" -d '{"who":{"clientKey":"curl-bob-key"},"handle":"bob"}'

echo "2. check a line: send the text, broadcast line.text to every seat except those in hiddenFor"
call -X POST "$BASE/v1/rooms/$ROOM/seats/alice/lines" -H "Idempotency-Key: curl-line-1" -d '{"text":"good luck, have fun"}'

echo "3. check a line the filter refuses (a test word of the starter list): ok is false and the reason says why"
call -X POST "$BASE/v1/rooms/$ROOM/seats/alice/lines" -H "Idempotency-Key: curl-line-2" -d '{"text":"you zorbak"}'

echo "4. report a player (bob reports alice): no report id comes back"
call -X POST "$BASE/v1/rooms/$ROOM/seats/bob/reports" -H "Idempotency-Key: curl-report-1" -d '{"target":"alice","reason":"harassment"}'

echo "5. the notices a player has not seen, and what they are restricted from"
call -X POST "$BASE/v1/notices/pending" -d '{"who":{"clientKey":"curl-alice-key"}}'
call -X POST "$BASE/v1/restriction" -d '{"who":{"clientKey":"curl-alice-key"}}'

echo "6. the login check: may this person join?"
call -X POST "$BASE/v1/doors/check" -d '{"kind":"join","who":{"clientKey":"curl-alice-key"}}'

echo "7. clean up: empty a seat, close the room"
call -X DELETE "$BASE/v1/rooms/$ROOM/seats/alice"
call -X DELETE "$BASE/v1/rooms/$ROOM"
