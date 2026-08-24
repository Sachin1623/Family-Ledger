import React from 'react';
import { useSearchParams } from 'react-router-dom';
import FeedList from '../components/FeedList';
import { useLanguage } from '../context/LanguageContext';

// Full-page fallback for direct navigation to /feed (deep links, bookmarks) — the primary way to
// view the feed is now Header's slide-over FeedPanel, which reuses the same FeedList. A group
// card's Feed button deep-links here as `?groupId=...` to open pre-filtered to that group — read
// directly (not via a mount-only effect) since this screen can already be mounted when a new
// `?groupId=` arrives.
export default function ActivityFeed() {
  const [searchParams] = useSearchParams();
  const groupId = searchParams.get('groupId') || undefined;
  const { t } = useLanguage();

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-6">
        <div className="max-w-3xl mx-auto space-y-6" data-tour="feed-list">
          <div className="flex flex-col gap-1">
            <h2 className="text-2xl font-bold text-primary">{t('feed.title')}</h2>
            <p className="text-text-muted">{t('feed.subtitle')}</p>
          </div>
          <FeedList initialGroupId={groupId} />
        </div>
      </main>
    </div>
  );
}
