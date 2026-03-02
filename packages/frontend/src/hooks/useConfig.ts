import { useState, useEffect, useCallback } from 'react';

interface AppConfig {
  scanPaths: string[];
  projectMarkers: string[];
  scanDepth: number;
  port: number;
  maxInstances: number;
}

export function useConfig() {
  const [config, setConfig] = useState<AppConfig | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/config');
      const data = await res.json() as AppConfig;
      setConfig(data);
    } catch (err) {
      console.error('Failed to fetch config:', err);
    }
  }, []);

  const updateConfig = useCallback(async (updates: Partial<AppConfig>) => {
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await res.json() as AppConfig;
      setConfig(data);
      return data;
    } catch (err) {
      console.error('Failed to update config:', err);
      throw err;
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  return { config, updateConfig, refetch: fetchConfig };
}
