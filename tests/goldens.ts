// Written by crew's Go tests (-update-golden) from voiceos/testdata. Do not edit.

export const devWatchRunning = {
  "ref": "store-front/main",
  "running": true,
  "proxied": false,
  "servers": [
    {
      "project": "store-front",
      "server": "web",
      "port": 54010,
      "url": "http://localhost:54010",
      "state": "up"
    },
    {
      "project": "store-api",
      "server": "api",
      "port": 54012,
      "url": "http://localhost:54012",
      "state": "died",
      "tail": "Error: Cannot find module 'express'"
    },
    {
      "project": "store-api",
      "server": "worker",
      "port": 0,
      "url": "",
      "state": "quiet"
    },
    {
      "project": "signals",
      "server": "rtc",
      "port": 54014,
      "url": "",
      "state": "stopped"
    }
  ],
  "setup": {
    "running": false,
    "failed": false,
    "projects": []
  },
  "health": {
    "at": "2026-10-02T09:30:00Z",
    "issues": [
      {
        "stage": "smoke",
        "project": "store-api",
        "server": "api",
        "reason": "died",
        "detail": "Error: Cannot find module 'express'"
      }
    ]
  }
}
export const devWatchStopped = {
  "ref": "store-front/main",
  "running": false,
  "proxied": false,
  "servers": [
    {
      "project": "store-front",
      "server": "web",
      "port": 54010,
      "url": "",
      "state": "stopped"
    },
    {
      "project": "store-api",
      "server": "api",
      "port": 54012,
      "url": "",
      "state": "stopped"
    },
    {
      "project": "store-api",
      "server": "worker",
      "port": 0,
      "url": "",
      "state": "stopped"
    },
    {
      "project": "signals",
      "server": "rtc",
      "port": 54014,
      "url": "",
      "state": "stopped"
    }
  ],
  "setup": {
    "running": true,
    "failed": false,
    "projects": [
      {
        "project": "store-front",
        "state": "ok",
        "steps": [
          {
            "name": "checkout",
            "status": "ok",
            "started_at": "0001-01-01T00:00:00Z",
            "took_ms": 1200
          }
        ],
        "issues": [],
        "took_ms": 42000,
        "at": "2026-10-02T09:30:00Z"
      },
      {
        "project": "store-api",
        "state": "running",
        "steps": [
          {
            "name": "checkout",
            "status": "ok",
            "started_at": "0001-01-01T00:00:00Z",
            "took_ms": 900
          },
          {
            "name": "pnpm install",
            "status": "running",
            "started_at": "2026-10-02T09:30:00Z"
          }
        ],
        "issues": [],
        "at": "2026-10-02T09:30:00Z"
      }
    ]
  },
  "health": null
}
export const which = {
  "ref": "store-front/main",
  "root": "/w/store-front/main",
  "project": "store-api"
}
export const crewArgv = [
	[
		"which",
		"/w/store-front/main/store-api",
		"--json"
	],
	[
		"dev",
		"watch",
		"store-front/main",
		"--json"
	],
	[
		"dev",
		"logs",
		"store-front/main",
		"store-front/web",
		"-f"
	],
	[
		"dev",
		"restart",
		"store-front/main",
		"store-front/web"
	],
	[
		"dev",
		"restart",
		"store-front/main"
	],
	[
		"dev",
		"start",
		"store-front/main"
	],
	[
		"dev",
		"stop",
		"store-front/main"
	],
	[
		"fix",
		"store-front/main",
		"--print"
	],
	[
		"start",
		"store-front/main"
	],
	[
		"setup",
		"logs",
		"store-front/main",
		"store-api",
		"--json",
		"--lines=200"
	],
	[
		"dev",
		"watch",
		"store-front/main",
		"--once",
		"--json"
	],
	[
		"dev",
		"restart",
		"store-front/main",
		"--proxy"
	],
	[
		"dev",
		"restart",
		"store-front/main",
		"--no-proxy"
	]
]
