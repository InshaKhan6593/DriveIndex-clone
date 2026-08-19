// Serverless entrypoint for the read API.
//
// Vercel's Node runtime invokes a module's export as (req, res) — which is exactly what an
// Express app IS, so this file is a handoff rather than an adapter. All the routing, gating and
// serialisation stays in server.js, unchanged and still runnable as a normal process locally:
// server.js only calls app.listen() when it is the main module.
//
// The data comes from TURSO_DATABASE_URL rather than a file. A serverless function cannot carry
// the 178MB snapshot, and db/client.js already switches to hosted libSQL when that variable is
// set, so nothing in the API had to change for this.
//
// Everything is routed here by the catch-all rewrite in vercel.json, so Express sees the real
// request path (/api/cars, /api/health, ...) and matches its own routes normally.
"use strict";

const { app } = require("./server");

module.exports = app;
