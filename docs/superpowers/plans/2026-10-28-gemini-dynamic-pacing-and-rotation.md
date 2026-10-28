# Plano de Implementação: Balanceamento Dinâmico, Pacing por RPM e Cooldown Otimizado no Gemini

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolver pausas excessivas na fila do Gemini através de pacing dinâmico de RPM `(60/rpm + 1)`, chaveamento proativo com transbordo, teto de 30s para cooldowns transitórios e correção do falso positivo de "billing".

**Architecture:** O `RateLimitTracker` calcula o pacing de cada modelo em tempo de execução. O modelo configurado pelo usuário é sempre prioritário; se estiver em janela de pacing ou cooldown, a requisição transborda proativamente para o próximo modelo com RPD livre. Cooldowns por 429/503 recebem teto de 30s e isolamento por modelo, e pausas de fila longas são eliminadas enquanto houver qualquer RPD livre.

**Tech Stack:** TypeScript, Bun Test, Google Gemini API v1beta, React / Tailwind (Viewer).

---

## Global Constraints
- Nenhuma dependência externa nova.
- Preservar integridade dos testes de regressão existentes em `tests/gemini_rate_limits_cascade.test.ts` e `tests/gemini_dynamic_cascade.test.ts`.
- Manter compatibilidade com Free Tier e PAYG.

---

### Task 1: Correção do Bug de "Billing" e Teto de Cooldown de 30s no RateLimitTracker

**Files:**
- Modify: `src/services/worker/gemini/RateLimitTracker.ts`
- Test: `tests/gemini_rate_limits_cascade.test.ts`

- [ ] **Step 1: Escrever teste unitário para o falso positivo de "billing" em modelo Flash-Lite e teto de 30s**
- [ ] **Step 2: Executar teste e verificar falha**
  `powershell -Command "$HOME\.bun\bin\bun.exe test tests/gemini_rate_limits_cascade.test.ts"`
- [ ] **Step 3: Ajustar `recordRequestFailure` em `RateLimitTracker.ts` para teto de 30s e verificação restrita de Pro para billing**
- [ ] **Step 4: Executar teste e verificar passagem**
- [ ] **Step 5: Commit das alterações da Task 1**

---

### Task 2: Implementação do Pacing Dinâmico `(60/rpm + 1)` e Transbordo Proativo

**Files:**
- Modify: `src/services/worker/gemini/RateLimitTracker.ts`
- Test: `tests/gemini_rate_limits_cascade.test.ts`

- [ ] **Step 1: Escrever testes unitários para cálculo dinâmico de pacing e transbordo proativo**
- [ ] **Step 2: Executar teste e verificar falha**
- [ ] **Step 3: Implementar `getDynamicPacingMs` e lógica de transbordo em `selectBestAvailableModel`**
- [ ] **Step 4: Executar teste e verificar passagem**
- [ ] **Step 5: Commit das alterações da Task 2**

---

### Task 3: Integração no GeminiProvider e Ajustes na Fila / Broadcaster

**Files:**
- Modify: `src/services/worker/GeminiProvider.ts`
- Modify: `src/ui/viewer/components/GeminiStatusModal.tsx`
- Test: `tests/worker/gemini-admission.test.ts`
- Test: `tests/gemini_dynamic_cascade.test.ts`

- [ ] **Step 1: Ajustar `waitForReservation` em `GeminiProvider.ts` para respeitar a espera dinâmica curta**
- [ ] **Step 2: Atualizar mensagem de alerta de pausa em `GeminiStatusModal.tsx`**
- [ ] **Step 3: Executar testes de admissão e cascata**
- [ ] **Step 4: Commit das alterações da Task 3**

---

### Task 4: Verificação Completa e Build

- [ ] **Step 1: Executar suite completa de testes com Bun**
- [ ] **Step 2: Executar build e sincronização (`npm run build`)**
