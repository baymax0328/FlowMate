// 被 probe-base.test.mjs 以子进程方式调用：打印解析出来的基址。
// 指向 8080 时 probeBase() 自己会 exit(2)，所以这里只要「成功就打印」即可。
import { probeBase } from './probe-base.mjs';

process.stdout.write(probeBase(['PROBE_BASE']) + '\n');
