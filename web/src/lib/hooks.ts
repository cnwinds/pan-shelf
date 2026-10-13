import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Account, type Job, type Overview, type Settings, type Source } from './api';

export const useOverview = () => useQuery({ queryKey: ['overview'], queryFn: () => api.get<Overview>('/overview'), refetchInterval: 30_000 });
export const useAccount = (fresh = false) => useQuery({ queryKey: ['account', fresh], queryFn: () => api.get<Account>('/account' + (fresh ? '?fresh=1' : '')), refetchInterval: 60_000 });
export const useSources = () => useQuery({ queryKey: ['sources'], queryFn: () => api.get<Source[]>('/sources') });
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ settings: Settings; defaults: Settings }>('/settings') });

export function useJobAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'pause' | 'resume' | 'cancel' | 'rerun' }) => api.post<Job>(`/jobs/${id}/${action}`),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['overview'] }); qc.invalidateQueries({ queryKey: ['jobs'] }); },
  });
}

export function useStartJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { type: string; source_id?: string | null; params?: Record<string, unknown> }) => api.post<Job>('/jobs', body),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['overview'] }); qc.invalidateQueries({ queryKey: ['jobs'] }); },
  });
}
