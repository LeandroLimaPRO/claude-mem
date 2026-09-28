import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { RateLimitTracker } from '../../gemini/RateLimitTracker.js';
import { DynamicModelRegistry } from '../../gemini/DynamicModelRegistry.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { paths } from '../../../../shared/paths.js';
import { getCredential } from '../../../../shared/EnvManager.js';
import { isForeignLoopbackBrowserWrite } from './SettingsRoutes.js';

export class GeminiRoutes extends BaseRouteHandler {
  constructor() {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/gemini/status', this.handleGetStatus.bind(this));
    app.post('/api/gemini/refresh', this.handleRefreshModels.bind(this));
    app.post('/api/gemini/calibrate-rpd', this.handleCalibrateRpd.bind(this));
    app.post('/api/gemini/tier', this.handleSetTier.bind(this));
  }

  private handleGetStatus = this.wrapHandler((req: Request, res: Response): void => {
    res.json(RateLimitTracker.getInstance().getStatus());
  });

  private handleRefreshModels = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    if (isForeignLoopbackBrowserWrite(req)) {
      res.status(403).json({ error: 'Gemini writes from a different localhost origin are not allowed' });
      return;
    }
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY') || '';

    const registry = DynamicModelRegistry.getInstance();
    try {
      await registry.discoverModels(apiKey, true, true);
    } catch {
      res.status(502).json({ error: 'Gemini model discovery failed; catalog retained' });
      return;
    }

    const tracker = RateLimitTracker.getInstance();
    res.json(tracker.getStatus());
  });

  private handleCalibrateRpd = this.wrapHandler((req: Request, res: Response): void => {
    if (isForeignLoopbackBrowserWrite(req)) {
      res.status(403).json({ error: 'Gemini writes from a different localhost origin are not allowed' });
      return;
    }
    const { model, count } = req.body ?? {};
    if (typeof model !== 'string' || !DynamicModelRegistry.getInstance().getCascade().some(m => m.id === model) ||
        typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      res.status(400).json({ error: 'Invalid model or count. Expected model: string, count: non-negative number' });
      return;
    }
    const tracker = RateLimitTracker.getInstance();
    tracker.calibrateRpd(model, count);
    res.json(tracker.getStatus());
  });

  private handleSetTier = this.wrapHandler((req: Request, res: Response): void => {
    if (isForeignLoopbackBrowserWrite(req)) {
      res.status(403).json({ error: 'Gemini writes from a different localhost origin are not allowed' });
      return;
    }
    const { tier } = req.body ?? {};
    if (tier !== 'free' && tier !== 'payg') {
      res.status(400).json({ error: 'Invalid tier. Expected "free" or "payg"' });
      return;
    }
    const tracker = RateLimitTracker.getInstance();
    tracker.setTier(tier);
    res.json(tracker.getStatus());
  });
}
