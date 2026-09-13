#!/usr/bin/env node
import { Effect } from "effect";
import { runCli } from "./cli.js";

await Effect.runPromise(runCli(process.argv.slice(2)));
