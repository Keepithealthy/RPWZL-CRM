import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ERR, type LeadCard, type LeadPatch, type LeadRow } from '../../lib/contract';
import { CrmError, errorText, rpc, toCrmError } from '../../lib/api';
import { useUi } from '../../components/ui';

export function useCard(id: number) {
  return useQuery({ queryKey: ['lead', id], queryFn: () => rpc('lead_get', { p_entry_id: id }), enabled: Number.isFinite(id) });
}

/** After any write on a lead: card, timeline, lists, today, tasks. */
export function invalidateLead(qc: QueryClient, id?: number) {
  void qc.invalidateQueries({ queryKey: id ? ['lead', id] : ['lead'] });
  void qc.invalidateQueries({ queryKey: ['timeline'] });
  void qc.invalidateQueries({ queryKey: ['leads'] });
  void qc.invalidateQueries({ queryKey: ['today'] });
  void qc.invalidateQueries({ queryKey: ['tasks'] });
}

/** Optimistic-lock patch: sends the card's version; on CR409 reloads the card and says so. */
export function useLeadPatch(card: LeadCard) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const entryId = card.row.id;
  return useMutation<LeadRow, CrmError, { patch: LeadPatch; okText?: string }>({
    mutationFn: async ({ patch }) => {
      try {
        return await rpc('lead_update', { p_entry_id: entryId, p_version: card.row.version, p_patch: patch });
      } catch (e) {
        throw toCrmError(e);
      }
    },
    onSuccess: (_row, { okText }) => {
      toast(okText ?? 'Zapisano');
      invalidateLead(qc, entryId);
    },
    onError: (e) => {
      toast(errorText(e), 'error');
      if (e.code === ERR.CONFLICT) invalidateLead(qc, entryId);
    },
  });
}
