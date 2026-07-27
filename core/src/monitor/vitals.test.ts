import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VITALS_UNSUPPORTED, parseVitals } from './vitals';

const STAT_8CORE = [
  'cpu  1000 50 300 8000 200 10 20 5 0 0',
  ...Array.from({ length: 8 }, (_, i) => `cpu${i} ${125 + i} 6 37 1000 25 1 2 0 0 0`),
  'intr 12345',
  'ctxt 6789',
].join('\n');

const MEMINFO = [
  'MemTotal:       16384000 kB',
  'MemFree:         2048000 kB',
  'MemAvailable:    8192000 kB',
  'Buffers:          512000 kB',
  'Cached:          4096000 kB',
  'SwapTotal:       4194304 kB',
  'SwapFree:        4000000 kB',
].join('\n');

const DF_GNU = [
  'Filesystem     1024-blocks      Used Available Capacity Mounted on',
  'udev               8137128         0   8137128       0% /dev',
  'tmpfs              1635028      2140   1632888       1% /run',
  '/dev/nvme0n1p2   479079112 218078936 236594440      48% /',
  'tmpfs              8175128    102400   8072728       2% /dev/shm',
  '/dev/nvme0n1p1      523248      5976    517272       2% /boot/efi',
  '/dev/nvme0n1p2   479079112 218078936 236594440      48% /home/mounted twice',
  'nas:/volume1      11538664848 9126091776 2412573072  80% /mnt/nas',
].join('\n');

const DF_BUSYBOX = [
  'Filesystem           1024-blocks    Used Available Capacity Mounted on',
  'overlay               61255492  22345520  35768556  38% /',
  'tmpfs                    65536         0     65536   0% /dev',
  'shm                      65536         0     65536   0% /dev/shm',
  '/dev/sda1             61255492  22345520  35768556  38% /etc/hosts',
].join('\n');

const DF_OVERLAY_ONLY = [
  'Filesystem           1024-blocks    Used Available Capacity Mounted on',
  'overlay               61255492  22345520  35768556  38% /',
  'tmpfs                    65536         0     65536   0% /dev',
].join('\n');

const NETDEV = [
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '    lo: 4644764   45813    0    0    0     0          0         0  4644764   45813    0    0    0     0       0          0',
  '  eth0: 987654321  765432    0    0    0     0          0      1234 123456789  654321    0    0    0     0       0          0',
  'veth1a2b: 1111 22 0 0 0 0 0 0 3333 44 0 0 0 0 0 0',
].join('\n');

function fixture(df: string): string {
  return [
    STAT_8CORE,
    '=P1',
    MEMINFO,
    '=P2',
    '0.42 0.36 0.30 2/1234 56789',
    '=P3',
    '1234567.89 9876543.21',
    '=P4',
    '6.8.0-45-generic',
    '=P5',
    df,
    '=P6',
    NETDEV,
  ].join('\n');
}

test('parses a full GNU-userland sample', () => {
  const v = parseVitals(fixture(DF_GNU));
  // cpu: idle = 8000 + 200, total = sum of first 8 fields
  assert.deepEqual(v.cpu, { idle: 8200, total: 9585 });
  assert.equal(v.cores.length, 8);
  assert.deepEqual(v.loadavg, [0.42, 0.36, 0.3]);
  assert.equal(v.uptimeSec, 1234567.89);
  assert.equal(v.kernel, '6.8.0-45-generic');
  assert.equal(v.memTotalKB, 16384000);
  assert.equal(v.memAvailableKB, 8192000);
  assert.equal(v.swapTotalKB, 4194304);
  assert.equal(v.swapFreeKB, 4000000);
});

test('df filtering keeps real devices, drops pseudo-fs, dedupes bind mounts', () => {
  const v = parseVitals(fixture(DF_GNU));
  assert.deepEqual(
    v.mounts.map((m) => m.mount),
    ['/', '/boot/efi', '/mnt/nas'], // nvme0n1p2 deduped to its shortest mount
  );
  const root = v.mounts.find((m) => m.mount === '/')!;
  assert.equal(root.totalKB, 479079112);
  assert.equal(root.usedKB, 218078936);
});

test('busybox df parses; /etc/hosts bind row is the only real device', () => {
  const v = parseVitals(fixture(DF_BUSYBOX));
  assert.deepEqual(
    v.mounts.map((m) => m.fs),
    ['/dev/sda1'],
  );
});

test('overlay-only df falls back to the / row instead of returning nothing', () => {
  const v = parseVitals(fixture(DF_OVERLAY_ONLY));
  assert.equal(v.mounts.length, 1);
  assert.equal(v.mounts[0].mount, '/');
  assert.equal(v.mounts[0].fs, 'overlay');
});

test('net excludes lo, keeps physical and virtual ifaces with raw counters', () => {
  const v = parseVitals(fixture(DF_GNU));
  assert.deepEqual(v.net, [
    { name: 'eth0', rxBytes: 987654321, txBytes: 123456789 },
    { name: 'veth1a2b', rxBytes: 1111, txBytes: 3333 },
  ]);
});

test('MemAvailable falls back to MemFree+Buffers+Cached when absent', () => {
  const noAvail = fixture(DF_GNU).replace(/^MemAvailable:.*\n/m, '');
  const v = parseVitals(noAvail);
  assert.equal(v.memAvailableKB, 2048000 + 512000 + 4096000);
});

test('missing /proc/stat throws the unsupported marker', () => {
  assert.throws(
    () => parseVitals('sh: cat: /proc/stat: No such file or directory\n=P1\n=P2\n'),
    new RegExp(VITALS_UNSUPPORTED),
  );
});
