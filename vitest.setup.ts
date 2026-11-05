// Every suite runs offline (AC-14): outbound network is blocked for the whole test process.
import { blockNetwork } from './packages/testkit/src/network-guard.js';

blockNetwork();
