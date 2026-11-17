import { apiClient } from '../../api/client';
import type { TrainerReview } from './trainer-reviews.api';

export interface ReviewMetrics {
  reviewCount: number; ratingSum: number; averageRating: number | null; distribution: Record<string, number>;
}
export interface AdminReview extends TrainerReview { trainerId: string; trainerNameSnapshot: string }
export interface AdminTrainerSummary extends ReviewMetrics { trainerId: string; currentTrainerName: string; status: string | null }
export interface AdminReviewFilter { trainerId: string; fromDate: string; toDate: string; rating: string }
export interface AdminReviewPage<T> {
  items: T[]; page: number; limit: number; total: number; totalPages: number; asOf: string;
  range: { fromDate: string; toDate: string }; totals: ReviewMetrics; invalidReviewCount: number;
}
const query = (filter: AdminReviewFilter, page: number) => {
  const params = new URLSearchParams({ page: String(page) });
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
  return params;
};
export const adminTrainerReviewsApi = {
  summary: (filter: AdminReviewFilter, page: number, signal?: AbortSignal) =>
    apiClient.request<AdminReviewPage<AdminTrainerSummary>>(`/admin/trainer-reviews/summary?${query(filter, page)}`, { signal }),
  list: (filter: AdminReviewFilter, page: number, signal?: AbortSignal) =>
    apiClient.request<AdminReviewPage<AdminReview>>(`/admin/trainer-reviews?${query(filter, page)}`, { signal }),
  detail: (id: string, signal?: AbortSignal) => apiClient.request<AdminReview>(`/admin/trainer-reviews/${encodeURIComponent(id)}`, { signal }),
};
