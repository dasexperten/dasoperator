'use client';

import React, { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useApi, LoadState } from '../shared';

type Placement = {
  article_title: string;
  service: string;
  language: string;
  url: string;
  placement_date: string;
};

export default function ArticlesTab() {
  const { data, loading, error } = useApi<{ rows: Placement[] }>('/api/analytics/articles');
  const [service, setService] = useState('');
  const [language, setLanguage] = useState('');
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const services = useMemo(() => Array.from(new Set(rows.map(r => r.service))).sort(), [rows]);
  const languages = useMemo(() => Array.from(new Set(rows.map(r => r.language))).sort(), [rows]);
  const shown = rows.filter(r => (!service || r.service === service) && (!language || r.language === language));

  return (
    <section aria-label="Articles" className="wa-panel">
      <div className="wa-article-filters">
        <label>
          <span>Placement service</span>
          <select value={service} onChange={e => setService(e.target.value)}>
            <option value="">All</option>
            {services.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label>
          <span>Language</span>
          <select value={language} onChange={e => setLanguage(e.target.value)}>
            <option value="">All</option>
            {languages.map(code => <option key={code} value={code}>{code}</option>)}
          </select>
        </label>
      </div>
      <LoadState loading={loading} error={error ? 'Unable to load articles.' : null} />
      {!loading && !error && (
        <div className="wa-table-scroll">
          <table className="wa-table wa-articles-table dx-keep-table">
            <thead><tr>
              <th scope="col">Article</th>
              <th scope="col">Service</th>
              <th scope="col">Language</th>
              <th scope="col" aria-label="Link" />
              <th scope="col">Date</th>
            </tr></thead>
            <tbody>
              {shown.map(row => <tr key={row.url}>
                <td>{row.article_title}</td>
                <td>{row.service}</td>
                <td>{row.language}</td>
                <td><a className="wa-article-link" href={row.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${row.service}: ${row.article_title}`} title="Open article"><ExternalLink size={18} aria-hidden="true" /></a></td>
                <td><time dateTime={row.placement_date}>{row.placement_date.split('-').reverse().join('.')}</time></td>
              </tr>)}
              {!shown.length && <tr><td colSpan={5}>No articles.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
