import {
  actionCommandText,
  shq,
  type ContainerInfo,
  type OrchAction,
  type ProxmoxGuestInfo,
  type SubHostTarget,
  type SwarmNodeInfo,
  type SwarmServiceInfo,
} from '@pear/core';
import type { MenuItem } from '../menu/context-menu';

/** What a card's menu needs from its component: the same handlers the icon
 *  buttons use, plus copy. Kept as callbacks so the panel and the page share
 *  one builder without sharing their busy/error state. */
export interface OrchMenuDeps {
  act(busyKey: string, action: OrchAction, title?: string): void;
  jumpInto(busyKey: string, target: SubHostTarget, name: string): void;
  jumpIntoVm(busyKey: string, vmid: number, name: string): void;
  openTasks?(service: SwarmServiceInfo): void;
  copy(text: string, what: string): void;
}

function copy(d: OrchMenuDeps, label: string, text: string | undefined | null, what?: string): MenuItem {
  const value = (text ?? '').trim();
  const empty = !value || value === '—';
  return {
    label,
    icon: 'copy',
    disabled: empty,
    onClick: () => d.copy(value, what ?? label.replace(/^Copy /, '')),
  };
}

function command(d: OrchMenuDeps, label: string, text: string | undefined): MenuItem {
  return { label, icon: 'terminal', disabled: !text, onClick: () => d.copy(text ?? '', 'command') };
}

export function containerMenu(c: ContainerInfo, d: OrchMenuDeps): MenuItem[] {
  const a = (op: 'start' | 'stop' | 'restart' | 'logs'): OrchAction => ({
    type: 'container',
    id: c.id,
    name: c.name,
    op,
  });
  return [
    c.running
      ? { label: 'Stop', icon: 'stop', onClick: () => d.act(c.id, a('stop')) }
      : { label: 'Start', icon: 'play', onClick: () => d.act(c.id, a('start')) },
    { label: 'Restart', icon: 'refresh', disabled: !c.running, onClick: () => d.act(c.id, a('restart')) },
    { label: 'Logs', icon: 'logs', onClick: () => d.act(c.id, a('logs'), c.name) },
    {
      label: 'Jump in',
      icon: 'enter',
      disabled: !c.running,
      onClick: () => d.jumpInto(c.id, { type: 'docker', ref: c.name }, c.name),
    },
    { divider: true },
    copy(d, 'Copy name', c.name),
    copy(d, 'Copy container ID', c.id, 'container ID'),
    copy(d, 'Copy image', c.image),
    copy(d, 'Copy ports', c.ports),
    { divider: true },
    command(d, 'Copy logs command', actionCommandText(a('logs'))),
    command(d, 'Copy exec command', `docker exec -it ${shq(c.name)} sh`),
  ];
}

export function projectMenu(project: string, containers: ContainerInfo[], d: OrchMenuDeps): MenuItem[] {
  const key = 'p:' + project;
  const a = (op: 'start' | 'stop' | 'restart' | 'logs'): OrchAction => ({ type: 'compose', project, op });
  const running = containers.filter((c) => c.running).length;
  return [
    { label: 'Start project', icon: 'play', disabled: running === containers.length, onClick: () => d.act(key, a('start')) },
    { label: 'Restart project', icon: 'refresh', disabled: running === 0, onClick: () => d.act(key, a('restart')) },
    { label: 'Stop project', icon: 'stop', disabled: running === 0, onClick: () => d.act(key, a('stop')) },
    { label: 'Project logs', icon: 'logs', onClick: () => d.act(key, a('logs'), project) },
    { divider: true },
    copy(d, 'Copy project name', project, 'project name'),
    command(d, 'Copy logs command', actionCommandText(a('logs'))),
  ];
}

export function serviceMenu(s: SwarmServiceInfo, d: OrchMenuDeps): MenuItem[] {
  const logs: OrchAction = { type: 'service', name: s.name, op: 'logs' };
  const items: MenuItem[] = [{ label: 'Logs', icon: 'logs', onClick: () => d.act(s.id, logs, s.name) }];
  if (d.openTasks) items.push({ label: 'Tasks', icon: 'activity', onClick: () => d.openTasks!(s) });
  items.push({
    label: 'Force restart',
    icon: 'refresh',
    onClick: () => d.act(s.id, { type: 'service', name: s.name, op: 'restart' }),
  });
  if (s.mode !== 'global') {
    items.push(
      {
        label: `Scale up to ${s.desired + 1}`,
        icon: 'plus',
        onClick: () => d.act(s.id, { type: 'service', name: s.name, op: 'scale', replicas: s.desired + 1 }),
      },
      {
        label: `Scale down to ${Math.max(0, s.desired - 1)}`,
        icon: 'minus',
        disabled: s.desired <= 0,
        onClick: () => d.act(s.id, { type: 'service', name: s.name, op: 'scale', replicas: s.desired - 1 }),
      },
    );
  }
  items.push(
    { divider: true },
    copy(d, 'Copy name', s.name),
    copy(d, 'Copy service ID', s.id, 'service ID'),
    copy(d, 'Copy image', s.image),
    copy(d, 'Copy ports', s.ports),
    { divider: true },
    command(d, 'Copy logs command', actionCommandText(logs)),
    command(d, 'Copy ps command', `docker service ps --no-trunc ${shq(s.name)}`),
  );
  return items;
}

export function nodeMenu(n: SwarmNodeInfo, d: OrchMenuDeps): MenuItem[] {
  return [
    copy(d, 'Copy node name', n.name, 'node name'),
    copy(d, 'Copy address', n.addr),
    command(d, 'Copy inspect command', `docker node inspect ${shq(n.name)} --pretty`),
  ];
}

export function guestMenu(g: ProxmoxGuestInfo, d: OrchMenuDeps): MenuItem[] {
  const key = 'g' + g.vmid;
  const a = (op: 'start' | 'shutdown' | 'reboot' | 'console'): OrchAction => ({
    type: 'guest',
    vmid: g.vmid,
    guestType: g.type,
    op,
  });
  const jump: MenuItem =
    g.type === 'lxc'
      ? {
          label: 'Jump in',
          icon: 'enter',
          disabled: !g.running,
          onClick: () => d.jumpInto(key, { type: 'lxc', ref: '' + g.vmid }, g.name),
        }
      : {
          label: 'Jump in (guest agent IP)',
          icon: 'enter',
          disabled: !g.running,
          onClick: () => d.jumpIntoVm(key, g.vmid, g.name),
        };
  return [
    g.running
      ? { label: 'Shutdown', icon: 'stop', onClick: () => d.act(key, a('shutdown')) }
      : { label: 'Start', icon: 'play', onClick: () => d.act(key, a('start')) },
    { label: 'Reboot', icon: 'refresh', disabled: !g.running, onClick: () => d.act(key, a('reboot')) },
    { label: 'Console', icon: 'terminal', onClick: () => d.act(key, a('console'), g.name) },
    jump,
    { divider: true },
    copy(d, 'Copy VMID', String(g.vmid)),
    copy(d, 'Copy name', g.name),
    { divider: true },
    command(d, 'Copy console command', actionCommandText(a('console'))),
  ];
}

export function alertMenu(s: SwarmServiceInfo, latestError: string | undefined, d: OrchMenuDeps): MenuItem[] {
  const items: MenuItem[] = [];
  if (d.openTasks) items.push({ label: 'Inspect tasks', icon: 'activity', onClick: () => d.openTasks!(s) });
  items.push(copy(d, 'Copy error', latestError), copy(d, 'Copy service name', s.name, 'service name'));
  return items;
}
