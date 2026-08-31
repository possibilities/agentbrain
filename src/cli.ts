#!/usr/bin/env bun
import { main } from "./dispatch";

if (import.meta.main) void main(Bun.argv.slice(2));
