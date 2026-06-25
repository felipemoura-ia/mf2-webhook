const express = require('express')
const cors = require('cors')
require('dotenv').config()

const { createClient } = require("@supabase/supabase-js")
const Stripe = require("stripe")

const app = express()
app.use(cors())

// ============================================================
// STRIPE WEBHOOK — deve vir ANTES do express.json() global
// Usa express.raw para preservar o body bruto para verificação
// ============================================================
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('[STRIPE] Variáveis STRIPE_SECRET_KEY ou STRIPE_WEBHOOK_SECRET não configuradas')
    return res.status(500).json({ error: 'Stripe não configurado' })
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY)

  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('[STRIPE] Assinatura inválida:', err.message)
    return res.status(400).json({ error: 'Assinatura inválida' })
  }

  console.log(`[STRIPE] Evento recebido: ${event.type}`)

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object
        const organizationId = session.metadata?.organization_id
        if (!organizationId) {
          console.error('[STRIPE] checkout.session.completed sem organization_id no metadata')
          break
        }
        const customerId = session.customer
        const subscriptionId = session.subscription
        await supabase
          .from('organizations')
          .update({
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
          })
          .eq('id', organizationId)
        console.log(`[STRIPE] Vínculo inicial salvo para org ${organizationId}`)
        break
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object
        const customerId = sub.customer
        const status = sub.status
        const trialEnd = sub.trial_end
          ? new Date(sub.trial_end * 1000).toISOString()
          : null
        const periodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null

        const updateData = {
          subscription_status: status,
          trial_ends_at: trialEnd,
          current_period_end: periodEnd,
        }

        // Limpa past_due_since se status voltou ao normal
        if (status !== 'past_due') {
          updateData.past_due_since = null
        }

        await supabase
          .from('organizations')
          .update(updateData)
          .eq('stripe_customer_id', customerId)

        console.log(`[STRIPE] Assinatura atualizada para customer ${customerId}: ${status}`)
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object
        const customerId = sub.customer
        await supabase
          .from('organizations')
          .update({ subscription_status: 'canceled' })
          .eq('stripe_customer_id', customerId)
        console.log(`[STRIPE] Assinatura cancelada para customer ${customerId}`)
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object
        const customerId = invoice.customer

        // Verifica se já tem past_due_since para não sobrescrever a data original
        const { data: org } = await supabase
          .from('organizations')
          .select('past_due_since')
          .eq('stripe_customer_id', customerId)
          .single()

        const updateData = { subscription_status: 'past_due' }
        if (!org?.past_due_since) {
          updateData.past_due_since = new Date().toISOString()
        }

        await supabase
          .from('organizations')
          .update(updateData)
          .eq('stripe_customer_id', customerId)

        console.log(`[STRIPE] Pagamento falhou para customer ${customerId}`)
        break
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object
        const customerId = invoice.customer
        await supabase
          .from('organizations')
          .update({
            subscription_status: 'active',
            past_due_since: null,
          })
          .eq('stripe_customer_id', customerId)
        console.log(`[STRIPE] Pagamento confirmado para customer ${customerId}`)
        break
      }

      default:
        console.log(`[STRIPE] Evento não tratado: ${event.type}`)
    }
  } catch (err) {
    console.error('[STRIPE] Erro ao processar evento:', err.message)
    return res.status(500).json({ error: 'Erro interno' })
  }

  res.json({ received: true })
})

// ============================================================
// Middleware JSON global — depois do webhook Stripe
// ============================================================
app.use(express.json({ limit: '10mb' }))

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const ADMIN_PHONE = process.env.ADMIN_PHONE || '5511983859141'
const processingQueue = new Map()

// Cooldown de notificações por lead (evita duplicatas em 30 minutos)
const notificationCooldown = new Map()
// Cooldown de confirmação de recebimento por telefone (quando lead está pausado)
const pausedAckCooldown = new Map()
const NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000

app.get('/', (req, res) => {
  res.json({ status: 'MF2 Webhook Server online', version: '1.5.0' })
})

// ============================================================
// STRIPE CREATE CHECKOUT — depois do express.json()
// ============================================================
app.post('/stripe/create-checkout', async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
    console.error('[STRIPE] Variáveis STRIPE_SECRET_KEY ou STRIPE_PRICE_ID não configuradas')
    return res.status(500).json({ error: 'Stripe não configurado' })
  }

  const { organization_id, success_url, cancel_url } = req.body

  if (!organization_id || !success_url || !cancel_url) {
    return res.status(400).json({ error: 'organization_id, success_url e cancel_url são obrigatórios' })
  }

  // Valida se a organização existe no Supabase
  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('id, name')
    .eq('id', organization_id)
    .single()

  if (orgError || !org) {
    console.error('[STRIPE] Organização não encontrada:', organization_id)
    console.error('[STRIPE] Detalhe do erro Supabase:', JSON.stringify(orgError))
    return res.status(404).json({ error: 'Organização não encontrada' })
  }

  try {

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: 14,
        metadata: {
          organization_id,
        },
      },
      metadata: {
        organization_id,
      },
      payment_method_collection: 'always',
      success_url,
      cancel_url,
    })

    console.log(`[STRIPE] Checkout Session criada para org ${organization_id}`)
    res.json({ url: session.url })
  } catch (err) {
    console.error('[STRIPE] Erro ao criar Checkout Session:', err.message)
    res.status(500).json({ error: 'Erro ao criar sessão de pagamento' })
  }
})

// ============================================================
// WEBHOOK WHATSAPP
// ============================================================
app.post('/webhook/whatsapp', async (req, res) => {
  res.json({ received: true })

  try {
    const payload = req.body
    const event = payload.event
    console.log(`[WEBHOOK] Evento recebido: ${event}`)
    if (event !== 'messages.upsert') return

    const data = payload.data
    if (!data) return
    if (data.key?.fromMe) return

    const phone = data.key?.remoteJid
      ?.replace('@s.whatsapp.net', '')
      ?.replace('@c.us', '')
      ?.replace(/[^0-9]/g, '')

    const content = data.message?.conversation
      || data.message?.extendedTextMessage?.text
      || data.message?.imageMessage?.caption
      || '[mídia]'

    if (!phone || phone.includes('-')) {
      console.log('[WEBHOOK] Ignorando mensagem de grupo ou sem telefone')
      return
    }

    if (processingQueue.get(phone)) {
      console.log(`[WEBHOOK] Aguardando processamento anterior para +${phone}`)
      await new Promise(r => setTimeout(r, 2000))
    }
    processingQueue.set(phone, true)

    try {
      await processMessage({ phone, content, payload, data })
    } finally {
      processingQueue.delete(phone)
    }
  } catch (err) {
    console.error('[WEBHOOK] Erro geral:', err)
  }
})

async function processMessage({ phone, content, payload, data }) {
  console.log(`[WEBHOOK] Processando mensagem de +${phone}: ${content.slice(0, 50)}`)

  const instanceName = payload.instance
  const { data: instance } = await supabase
    .from('whatsapp_instances')
    .select('organization_id')
    .eq('instance_name', instanceName)
    .single()

  if (!instance?.organization_id) {
    console.log(`[WEBHOOK] Instância não encontrada: ${instanceName}`)
    return
  }

  const orgId = instance.organization_id

  let lead
  const { data: existingLead } = await supabase
    .from('leads')
    .select('*')
    .eq('organization_id', orgId)
    .eq('phone', phone)
    .maybeSingle()

  if (existingLead) {
    lead = existingLead
    console.log(`[WEBHOOK] Lead existente: ${lead.id}`)
  } else {
    const pushName = data.pushName || null
    const { data: newLead, error } = await supabase
      .from('leads')
      .insert({ organization_id: orgId, phone, name: pushName, status: 'novo' })
      .select()
      .single()

    if (error) {
      console.error('[WEBHOOK] Erro ao criar lead:', error)
      return
    }
    lead = newLead
    console.log(`[WEBHOOK] Novo lead criado: ${lead.id}`)
  }

  // Registra mensagem recebida
  await supabase.from('lead_messages').insert({
    lead_id: lead.id,
    organization_id: orgId,
    direction: 'inbound',
    content,
    channel: 'whatsapp',
  })
  console.log(`[WEBHOOK] Mensagem registrada para lead ${lead.id}`)

  if (content === '[mídia]' && data.message?.audioMessage) {
    const audioReply = 'Recebi sua mensagem, mas não consigo ouvir áudios. Pode me enviar em texto?'
    await sendWhatsApp(phone, audioReply)
    await supabase.from('lead_messages').insert({
      lead_id: lead.id,
      organization_id: orgId,
      direction: 'outbound',
      content: audioReply,
      channel: 'whatsapp',
    })
    console.log(`[WEBHOOK] Áudio detectado, solicitação de texto enviada para +${phone}`)
    return
  }

  // Verifica se lead está pausado (aguardando atendimento humano)
  if (lead.agent_paused) {
    console.log(`[WEBHOOK] Lead ${lead.id} está pausado, aguardando humano. Mensagem registrada sem resposta automática.`)
    const now = Date.now()

    const lastAck = pausedAckCooldown.get(phone)
    if (!lastAck || (now - lastAck) > NOTIFICATION_COOLDOWN_MS) {
      const ackMessage = 'Sua mensagem foi recebida. O atendimento já está com nossa equipe e retornaremos em breve.'
      await sendWhatsApp(phone, ackMessage)
      await supabase.from('lead_messages').insert({
        lead_id: lead.id,
        organization_id: orgId,
        direction: 'outbound',
        content: ackMessage,
        channel: 'whatsapp',
      })
      pausedAckCooldown.set(phone, now)
      console.log(`[WEBHOOK] Confirmação de recebimento enviada para +${phone}`)
    } else {
      console.log(`[WEBHOOK] Confirmação de recebimento em cooldown para +${phone}`)
    }

    const lastNotification = notificationCooldown.get(lead.id)
    if (!lastNotification || (now - lastNotification) > NOTIFICATION_COOLDOWN_MS) {
      await notifyAdmin({
        phone,
        lead,
        content,
        reason: 'lead em espera — nova mensagem sem resposta do humano ainda'
      })
      notificationCooldown.set(lead.id, now)
    } else {
      console.log(`[WEBHOOK] Notificação em cooldown para lead ${lead.id}`)
    }
    return
  }

  const { data: agent } = await supabase
    .from('ai_agents')
    .select('*')
    .eq('organization_id', orgId)
    .eq('active', true)
    .maybeSingle()

  if (!agent) {
    console.log('[WEBHOOK] Agente IA inativo ou não configurado')
    return
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[WEBHOOK] Chave Anthropic não configurada')
    return
  }

  const pauseKeywords = agent.pause_keywords || ['humano', 'atendente', 'pessoa', 'gerente']
  const shouldPause = pauseKeywords.some(kw =>
    content.toLowerCase().includes(kw.toLowerCase())
  )

  if (shouldPause) {
    console.log('[WEBHOOK] Pausa automática por palavra-chave')
    const fallback = agent.fallback_message || 'Deixa eu verificar isso com nossa equipe e retorno em breve!'
    await supabase.from('lead_messages').insert({
      lead_id: lead.id,
      organization_id: orgId,
      direction: 'outbound',
      content: fallback,
      channel: 'whatsapp',
    })
    await sendWhatsApp(phone, fallback)
    await pauseLead(lead.id)
    await notifyAdmin({ phone, lead, content, reason: 'palavra-chave de pausa' })
    notificationCooldown.set(lead.id, Date.now())
    await supabase.from('ai_agent_logs').insert({
      organization_id: orgId,
      lead_id: lead.id,
      action: 'pausa_automatica',
      input: content,
      output: 'Pausa por palavra-chave',
    })
    return
  }

  const { data: history } = await supabase
    .from('lead_messages')
    .select('direction, content, created_at')
    .eq('lead_id', lead.id)
    .order('created_at', { ascending: true })
    .limit(20)

  const rawMessages = (history || []).map(msg => ({
    role: msg.direction === 'inbound' ? 'user' : 'assistant',
    content: msg.content,
  }))

  const dedupedMessages = []
  for (const msg of rawMessages) {
    if (dedupedMessages.length === 0 || dedupedMessages[dedupedMessages.length - 1].role !== msg.role) {
      dedupedMessages.push(msg)
    }
  }

  if (dedupedMessages.length === 0 || dedupedMessages[dedupedMessages.length - 1].role !== 'user') {
    dedupedMessages.push({ role: 'user', content })
  }

  const { data: knowledgeItems } = await supabase
    .from('knowledge_items')
    .select('question, answer, category')
    .eq('organization_id', orgId)
    .eq('active', true)
    .limit(30)

  const { data: documents } = await supabase
    .from('knowledge_documents')
    .select('name, content_text')
    .eq('organization_id', orgId)
    .eq('status', 'ready')
    .limit(5)

  let knowledgeContext = ''
  if (knowledgeItems?.length) {
    knowledgeContext += '\n\nPERGUNTAS E RESPOSTAS FREQUENTES:\n'
    knowledgeItems.forEach(item => {
      knowledgeContext += `P: ${item.question}\nR: ${item.answer}\n\n`
    })
  }
  if (documents?.length) {
    knowledgeContext += '\n\nDOCUMENTOS DE REFERÊNCIA:\n'
    documents.forEach(doc => {
      knowledgeContext += `[${doc.name}]:\n${doc.content_text?.slice(0, 2000)}\n\n`
    })
  }

  const isFirstMessage = !history || history.length === 0
  let historyContext = ''

  if (!isFirstMessage && history && history.length > 0) {
    historyContext = '\n\n---\nCONTEXTO DA CONVERSA ATUAL:\n'
    historyContext += 'Esta conversa já está em andamento. Use o histórico abaixo para continuar naturalmente.\n'
    historyContext += 'NÃO use a mensagem inicial de saudação. NÃO repita perguntas já respondidas.\n\n'
    historyContext += 'Histórico recente:\n'
    history.slice(-10).forEach(msg => {
      const role = msg.direction === 'inbound' ? 'Lead' : 'Agente'
      historyContext += `${role}: ${msg.content}\n`
    })
    historyContext += `\nMensagem atual do lead: "${content}"\n`
    historyContext += '\nInstrução: responda APENAS à mensagem atual considerando tudo que já foi dito. Avance a conversa.'
  } else {
    historyContext = '\n\n---\nEsta é a PRIMEIRA mensagem desta conversa. Use a mensagem inicial de saudação.'
  }

  const pauseInstruction = `

---
INSTRUÇÃO DE PAUSA OBRIGATÓRIA:
Quando decidir encaminhar para atendimento humano, sua resposta DEVE começar com [PAUSA_HUMANO] antes de qualquer texto.
Após usar [PAUSA_HUMANO], o sistema vai parar completamente de responder automaticamente.
O atendimento humano assumirá e só a equipe poderá reativar o agente.
Use [PAUSA_HUMANO] quando: lead pedir reunião, perguntar preço/proposta, demonstrar interesse em contratar, fazer pergunta técnica específica, pedir para falar com humano, ou for cliente atual.`

  const systemPrompt = (agent.system_prompt || 'Você é um assistente prestativo.')
    + knowledgeContext
    + historyContext
    + pauseInstruction

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 25000)

  let aiResponse
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: systemPrompt,
        messages: dedupedMessages,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!claudeRes.ok) {
      const err = await claudeRes.text()
      console.error('[WEBHOOK] Erro Claude:', err)
      await handleFallback({ phone, lead, orgId, content })
      return
    }

    const claudeData = await claudeRes.json()
    aiResponse = claudeData.content?.[0]?.text
  } catch (err) {
    clearTimeout(timeout)
    if (err.name === 'AbortError') {
      console.error('[WEBHOOK] Timeout na chamada ao Claude')
    } else {
      console.error('[WEBHOOK] Erro na chamada ao Claude:', err)
    }
    await handleFallback({ phone, lead, orgId, content })
    return
  }

  if (!aiResponse) {
    console.log('[WEBHOOK] Resposta vazia do Claude')
    await handleFallback({ phone, lead, orgId, content })
    return
  }

  const agentWantsPause = aiResponse.includes('[PAUSA_HUMANO]')
  const cleanResponse = aiResponse.replace('[PAUSA_HUMANO]', '').trim()

  console.log(`[WEBHOOK] Resposta IA: ${cleanResponse.slice(0, 80)}`)

  await sendWhatsApp(phone, cleanResponse)

  await supabase.from('lead_messages').insert({
    lead_id: lead.id,
    organization_id: orgId,
    direction: 'outbound',
    content: cleanResponse,
    channel: 'whatsapp',
  })

  if (agentWantsPause) {
    console.log('[WEBHOOK] Agente sinalizou encaminhamento para humano — pausando lead')
    await pauseLead(lead.id)
    await notifyAdmin({ phone, lead, content, reason: 'encaminhamento pela IA' })
    notificationCooldown.set(lead.id, Date.now())
    await supabase.from('ai_agent_logs').insert({
      organization_id: orgId,
      lead_id: lead.id,
      action: 'pausa_por_ia',
      input: content,
      output: cleanResponse,
    })
  } else {
    await supabase.from('ai_agent_logs').insert({
      organization_id: orgId,
      lead_id: lead.id,
      action: 'resposta_automatica',
      input: content,
      output: cleanResponse,
    })
  }

  console.log(`[WEBHOOK] Resposta enviada para +${phone}`)
}

async function pauseLead(leadId) {
  await supabase
    .from('leads')
    .update({ agent_paused: true, agent_paused_at: new Date().toISOString() })
    .eq('id', leadId)
  console.log(`[WEBHOOK] Lead ${leadId} marcado como pausado`)
}

async function handleFallback({ phone, lead, orgId, content }) {
  const fallback = 'Estou com uma instabilidade momentânea, mas sua mensagem foi registrada. A Carol ou o consultor de crescimento Felipe Moura vão te responder por aqui assim que possível.'
  console.log('[WEBHOOK] Enviando fallback por erro/timeout')
  await sendWhatsApp(phone, fallback)
  await supabase.from('lead_messages').insert({
    lead_id: lead.id,
    organization_id: orgId,
    direction: 'outbound',
    content: fallback,
    channel: 'whatsapp',
  })
  await notifyAdmin({ phone, lead, content, reason: 'erro/timeout na IA' })
}

async function notifyAdmin({ phone, lead, content, reason }) {
  const leadName = lead.name || `+${phone}`
  const message = `🔔 *Atendimento humano solicitado*\n\n` +
    `👤 Lead: ${leadName}\n` +
    `📱 Telefone: +${phone}\n` +
    `💬 Última mensagem: "${content.slice(0, 100)}"\n` +
    `📋 Motivo: ${reason}\n\n` +
    `Acesse o CRM para continuar o atendimento.`
  console.log(`[WEBHOOK] Notificando admin sobre pausa do lead +${phone}`)
  await sendWhatsApp(ADMIN_PHONE, message)
}

async function sendWhatsApp(phone, text) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE_NAME}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.EVOLUTION_API_KEY,
      },
      body: JSON.stringify({ number: phone, text }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
  } catch (err) {
    clearTimeout(timeout)
    console.error('[WEBHOOK] Erro ao enviar WhatsApp:', err.message)
  }
}

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`MF2 Webhook Server v1.5.0 rodando na porta ${PORT}`)
  console.log(`Aguardando webhooks em /webhook/whatsapp`)
  console.log(`Stripe: /stripe/create-checkout e /stripe/webhook`)
})
