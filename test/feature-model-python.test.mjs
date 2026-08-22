import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFeatureModel } from '../src/feature-model.mjs';

test('Python feature model follows project-local imports and FastAPI/SQLAlchemy boundaries', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-python-feature-'));
  try {
    fs.mkdirSync(path.join(cwd, 'app', 'api'), { recursive:true });
    fs.mkdirSync(path.join(cwd, 'app', 'services'), { recursive:true });
    fs.mkdirSync(path.join(cwd, 'app', 'models'), { recursive:true });
    fs.mkdirSync(path.join(cwd, 'tests'), { recursive:true });
    fs.writeFileSync(path.join(cwd, 'app', '__init__.py'), '');
    fs.writeFileSync(path.join(cwd, 'app', 'api', '__init__.py'), '');
    fs.writeFileSync(path.join(cwd, 'app', 'services', '__init__.py'), '');
    fs.writeFileSync(path.join(cwd, 'app', 'models', '__init__.py'), '');
    fs.writeFileSync(path.join(cwd, 'app', 'api', 'checkout.py'), `
from fastapi import APIRouter
from ..services.billing import create_checkout
router = APIRouter()

@router.post('/api/checkout')
async def checkout(payload: dict):
    return await create_checkout(payload)
`);
    fs.writeFileSync(path.join(cwd, 'app', 'services', 'billing.py'), `
import stripe
from app.models.subscription import Subscription

async def create_checkout(payload):
    return stripe.checkout.Session.create(**payload)
`);
    fs.writeFileSync(path.join(cwd, 'app', 'models', 'subscription.py'), `
from sqlalchemy.orm import DeclarativeBase
class Subscription(DeclarativeBase):
    __tablename__ = 'subscriptions'
`);
    fs.writeFileSync(path.join(cwd, 'tests', 'test_checkout.py'), `
from app.api.checkout import checkout
import pytest
`);

    const model = buildFeatureModel(cwd, {
      prompt:'Add FastAPI Stripe checkout and persist subscriptions with SQLAlchemy',
      currentResource:'app/api/checkout.py',
      touchedFiles:['app/api/checkout.py', 'tests/test_checkout.py'],
      taskSignals:{ file:'app/api/checkout.py', technologies:['FastAPI','Stripe'] }
    });

    assert.ok(model.nodes.some((node) => node.label === 'app/api/checkout.py' && node.role === 'api'));
    assert.ok(model.nodes.some((node) => node.label === 'app/services/billing.py' && node.role === 'service'));
    assert.ok(model.nodes.some((node) => node.label === 'app/models/subscription.py' && node.role === 'data'));
    assert.ok(model.edges.some((edge) => edge.from === 'file:app/api/checkout.py' && edge.to === 'file:app/services/billing.py' && edge.kind === 'imports'));
    assert.ok(model.edges.some((edge) => edge.from === 'file:app/services/billing.py' && edge.to === 'file:app/models/subscription.py' && edge.kind === 'imports'));
    assert.ok(model.surfaces.routes.includes('/api/checkout'));
    assert.ok(model.surfaces.tables.includes('subscriptions'));
    assert.ok(model.surfaces.technologies.includes('FastAPI'));
    assert.ok(model.surfaces.technologies.includes('Stripe'));
    assert.ok(model.surfaces.technologies.includes('SQLAlchemy'));
    assert.ok(model.tests.includes('tests/test_checkout.py'));
  } finally {
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});

test('Next.js file-system API routes become feature surfaces without runtime claims', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idleproof-next-feature-'));
  try {
    fs.mkdirSync(path.join(cwd, 'app', 'api', 'projects', '[id]'), { recursive:true });
    fs.writeFileSync(path.join(cwd, 'app', 'api', 'projects', '[id]', 'route.ts'), `
export async function GET() { return Response.json({ ok: true }); }
`);
    const model = buildFeatureModel(cwd, {
      prompt:'Read project API route',
      currentResource:'app/api/projects/[id]/route.ts',
      touchedFiles:['app/api/projects/[id]/route.ts']
    });
    assert.ok(model.surfaces.routes.includes('/api/projects/:id'));
    assert.match(model.disclaimer, /not a proven runtime call graph/i);
  } finally {
    fs.rmSync(cwd, { recursive:true, force:true });
  }
});
