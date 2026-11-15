import { useMemo } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { LeadFilter, LeadRow, ProposalDecision, ProposalStatus, ProposalSummary, ValidationQueue } from '../../lib/contract';
import { rpc } from '../../lib/api';
import { useRefOrNull } from '../../lib/queries';
import type { ProposalGroup } from './grouping';

export type QueueName = Exclude<ValidationQueue, 'records'>;
export const QUEUE_PAGE = 50;

export function useValSummary(filter: LeadFilter | null) {
  return useQuery({ queryKey: ['val', 'summary', filter], queryFn: () => rpc('val_summary', { p_filter: filter }), placeholderData: keepPreviousData });
}

export function useValQueue(queue: QueueName, status: ProposalStatus, filter: LeadFilter | null, page: number) {
  return useQuery({
    queryKey: ['val', 'queue', queue, status, filter, page],
    queryFn: () => rpc('val_queue', { p_queue: queue, p_status: status, p_filter: filter, p_offset: page * QUEUE_PAGE, p_limit: QUEUE_PAGE }),
    placeholderData: keepPreviousData,
  });
}

export function proposalDetailQuery(id: number) {
  return { queryKey: ['val', 'proposal', id] as const, queryFn: () => rpc('val_proposal_get', { p_id: id }) };
}

export function useProposalDetail(id: number | null) {
  return useQuery({ ...proposalDetailQuery(id ?? 0), enabled: id !== null });
}

export function useNetworks(enabled = true) {
  return useQuery({ queryKey: ['val', 'networks'], queryFn: () => rpc('networks_list', {}), enabled, staleTime: 60_000 });
}

/** Saved views as segments for "Pokaż tylko propozycje dla widoku". */
export function useSegments(): Array<{ id: number; name: string; filter: LeadFilter }> {
  const ref = useRefOrNull();
  return useMemo(() => (ref?.views ?? []).map((v) => ({ id: v.id, name: v.name, filter: v.filter })), [ref]);
}

export function invalidateValidation(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ['val'] });
  void qc.invalidateQueries({ queryKey: ['leads'] });
  void qc.invalidateQueries({ queryKey: ['lead'] });
  void qc.invalidateQueries({ queryKey: ['timeline'] });
  void qc.invalidateQueries({ queryKey: ['today'] });
}

export type GroupAction =
  | { type: 'accept' }
  | { type: 'accept-network'; networkId?: number; newNetworkName?: string; memberKeys: string[]; note?: string | null }
  | { type: 'reject' }
  | { type: 'reopen' };

async function link(entry: LeadRow, action: 'detach' | 'attach', accountKey: string | null) {
  await rpc('val_account_link', { p_entry_id: entry.id, p_action: action, p_account_key: accountKey, p_note: null });
}

/**
 * Applies one decision to every proposal of a card (cards of the "Sieci" queue can hold several proposals with identical
 * members). The side effects of SPEC 4.7 are done by `val_decide` itself (CONTRACT Deviations 10): accepting a `person`
 * proposal merges the accounts, rejecting an `account_check` splits the smaller class out, accepting a network moves
 * accounts of other networks. The client therefore only sends the decision (one transaction per proposal).
 */
export async function decideGroup(group: ProposalGroup, action: GroupAction): Promise<ProposalSummary[]> {
  const out: ProposalSummary[] = [];
  const decide = async (id: number, decision: ProposalDecision) => {
    out.push(await rpc('val_decide', { p_id: id, p_decision: decision }));
  };
  if (action.type === 'reopen') {
    for (const p of group.proposals) await decide(p.id, { decision: 'reopen' });
    return out;
  }
  if (action.type === 'reject') {
    for (const p of group.proposals) await decide(p.id, { decision: 'reject' });
    return out;
  }
  if (action.type === 'accept') {
    for (const p of group.proposals) await decide(p.id, { decision: 'accept' });
    return out;
  }
  // accept as a network: the first proposal creates (or joins) the network, the others join the same one
  let networkId = action.networkId;
  for (const p of group.proposals) {
    const decision: ProposalDecision = networkId !== undefined
      ? { decision: 'accept', networkId, memberKeys: action.memberKeys, note: action.note ?? null }
      : { decision: 'accept', newNetworkName: action.newNetworkName, memberKeys: action.memberKeys, note: action.note ?? null };
    await decide(p.id, decision);
    const last = out[out.length - 1];
    if (networkId === undefined && last?.networkId) networkId = last.networkId;
  }
  return out;
}

export function useDecideGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ group, action }: { group: ProposalGroup; action: GroupAction }) => decideGroup(group, action),
    onSettled: () => invalidateValidation(qc),
  });
}

export function useDetach() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entry: LeadRow) => link(entry, 'detach', null),
    onSettled: () => invalidateValidation(qc),
  });
}
