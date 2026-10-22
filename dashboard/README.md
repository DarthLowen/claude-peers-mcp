# Dashboard

The dashboard runs behind an identity-aware proxy. See your own deploy notes.

The page joins broker machine names to tailnet host names with a JSON map, read at startup. Copy `machines.example.json` to `machines.json` (gitignored), or set `CLAUDE_PEERS_MACHINE_MAP` to a file outside this repo. The server serves that object at `/machines.json`. An absent file means an empty map: peers still list, they just don't join a host.
