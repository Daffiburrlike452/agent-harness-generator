#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// `harness` binary entry point.

import { dispatch } from './subcommands.js';

const [, , subcommand = 'help', ...rest] = process.argv;

dispatch(subcommand, rest).then(({ code, lines }) => {
  // eslint-disable-next-line no-console
  for (const l of lines) console.log(l);
  process.exit(code);
}).catch(err => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
