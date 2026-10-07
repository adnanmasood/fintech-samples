"use strict";

// The browser observes participant state. All payment decisions and amounts come
// from the six Python programs; commands only request work from the supervisor.
window.__consoleErrors = [];
window.addEventListener("error", event => {
  window.__consoleErrors.push(String(event.message || "Browser error"));
});
window.addEventListener("unhandledrejection", event => {
  window.__consoleErrors.push(String(event.reason || "Unhandled rejection"));
});

(() => {
  const $ = id => document.getElementById(id);
  const money = value => Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", {style: "currency", currency: "USD"}).format(value / 100)
    : "—";
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
  const readable = value => String(value ?? "").replace(/_/g, " ").toLowerCase();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const roles = [
    {id:"payer", label:"Payer", subtitle:"Starts the purchase", icon:'<circle cx="10" cy="6" r="3"/><path d="M4 18v-2a6 6 0 0112 0v2M5 18h10"/>'},
    {id:"merchant", label:"Merchant / POS", subtitle:"Collects the card payment", icon:'<path d="M2 8l2-5h12l2 5M3 8v10h14V8M2 8h16M7 18v-6h6v6M6 3v5M10 3v5M14 3v5"/>'},
    {id:"gateway", label:"Gateway / Processor", subtitle:"Validates and routes", icon:'<rect x="3" y="3" width="14" height="14" rx="3"/><path d="M6 7h8M6 10h5M6 13h8M10 1v2M10 17v2M1 10h2M17 10h2"/>'},
    {id:"acquirer", label:"Acquirer", subtitle:"The merchant’s bank", icon:'<path d="M2 7l8-5 8 5H2M3 18h14M4 15h12M5 9v6M10 9v6M15 9v6"/>'},
    {id:"network", label:"Card network", subtitle:"Simulated Visa / Mastercard", icon:'<circle cx="4" cy="5" r="2"/><circle cx="16" cy="5" r="2"/><circle cx="10" cy="16" r="2"/><path d="M6 5h8M5 7l4 7M15 7l-4 7"/>'},
    {id:"issuer", label:"Issuer", subtitle:"The payer’s bank", icon:'<path d="M2 7l8-5 8 5H2M3 18h14M4 15h12M5 9v6M10 9v6M15 9v6"/>'}
  ];
  const roleAliases = {processor:"gateway", gateway_processor:"gateway", merchant_pos:"merchant", pos:"merchant", card_network:"network", visa:"network", mastercard:"network", issuing_bank:"issuer", acquiring_bank:"acquirer"};
  const canonicalRole = value => {
    const normalized = String(value ?? "").toLowerCase().replace(/[\s/]+/g,"_");
    return roleAliases[normalized] || normalized;
  };
  const roleIndex = value => roles.findIndex(role => role.id === canonicalRole(value));
  const roleLabel = value => roles.find(role => role.id === canonicalRole(value))?.label || String(value ?? "System").replace(/_/g," ");
  let state = null;
  let session = null;
  let lastSeq = 0;
  let events = [];
  let selectedPayment = null;
  let selectedEvent = null;
  let userSelectedPayment = false;
  let eventSelectionLocked = false;
  let pollInProgress = false;
  let pendingCommand = false;
  let connected = false;
  let animationQueue = [];
  let animationRunning = false;
  let animationGeneration = 0;
  let points = [];
  let toastTimer;
  let renderedPaymentsKey = "";
  let renderedEventsKey = "";

  $("agents").innerHTML = roles.map((role,index) => `<article class="agent-card" id="agent-${role.id}" aria-label="${role.label} process">
    <div class="agent-top"><span class="agent-icon"><svg viewBox="0 0 20 20" aria-hidden="true">${role.icon}</svg></span><span class="agent-number">0${index+1}</span></div>
    <h3 class="agent-name">${role.label}</h3><p class="agent-subtitle">${role.subtitle}</p>
    <div class="agent-meta"><span class="agent-pid"><i id="alive-${role.id}"></i><span id="pid-${role.id}">PID —</span></span><span id="counts-${role.id}" title="Received / sent">↓0 ↑0</span></div>
    <p class="agent-activity" id="activity-${role.id}">Waiting for supervisor</p></article>`).join("");

  function toast(message, isError=false) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").classList.toggle("error", isError);
    $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
  }

  function setConnection(isConnected, detail) {
    connected = isConnected;
    $("connection").classList.toggle("connected",isConnected);
    $("connection").classList.toggle("error",!isConnected);
    $("connection-text").textContent = detail;
    updateControls();
  }

  function showNotice(message) {
    $("notice").textContent = message || "";
    $("notice").hidden = !message;
  }

  function positionRails() {
    const stageRect = $("rail-stage").getBoundingClientRect();
    points = roles.map(role => {
      const rect = $("agent-"+role.id).querySelector(".agent-icon").getBoundingClientRect();
      return {x: rect.left - stageRect.left + rect.width/2, y:rect.top-stageRect.top+rect.height/2};
    });
    $("rail-svg").setAttribute("viewBox",`0 0 ${stageRect.width} ${stageRect.height}`);
    $("rail-links").innerHTML = points.slice(0,-1).map((point,index) => {
      // Join the actor cards across the gap, keeping labels unobscured.
      const source = $("agent-"+roles[index].id).getBoundingClientRect();
      const target = $("agent-"+roles[index+1].id).getBoundingClientRect();
      return `<line id="link-${index}" class="rail-link" x1="${source.right-stageRect.left+2}" y1="${point.y}" x2="${target.left-stageRect.left-3}" y2="${points[index+1].y}" marker-end="url(#request-arrow)"/>`;
    }).join("");
  }

  function clearAnimation() {
    animationGeneration += 1;
    animationQueue = [];
    animationRunning = false;
    setPacketVisible(false);
    document.querySelectorAll(".agent-card").forEach(card => card.classList.remove("active-request","active-response"));
    document.querySelectorAll(".rail-link").forEach(link => link.classList.remove("active"));
  }

  function setPacketVisible(visible) {
    // SVGElement has no HTMLElement.hidden setter. Toggle its actual attribute.
    $("packet").toggleAttribute("hidden", !visible);
    $("packet-halo").toggleAttribute("hidden", !visible);
  }

  function resetSession(nextSession) {
    session = nextSession;
    lastSeq = 0;
    events = [];
    selectedEvent = null;
    selectedPayment = null;
    userSelectedPayment = false;
    eventSelectionLocked = false;
    renderedPaymentsKey = "";
    renderedEventsKey = "";
    clearAnimation();
    $("live-message-text").textContent = "Six fresh processes are ready. Send a purchase to begin.";
    $("live-message-seq").textContent = "";
    renderInspector();
  }

  function eventTime(event) {
    const date = typeof event.timestamp === "number" ? new Date(event.timestamp * (event.timestamp<1e12?1000:1)) : new Date(event.timestamp);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("en-US",{hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"});
  }

  function eventExplanation(event) {
    if(event.explanation) return event.explanation;
    const sender = roleLabel(event.sender), recipient = roleLabel(event.recipient);
    const amount = money(event.amount_cents);
    const type = String(event.type || "message").toUpperCase();
    if(type.includes("AUTH") && event.outcome === "approved") return `${sender} approves ${amount} and sends the decision to ${recipient}. The payer’s funds are held; the posted balance has not changed.`;
    if(event.outcome === "declined" || type.includes("DECLINE")) return `${sender} sends a decline to ${recipient}. ${event.reason ? readable(event.reason)+"." : "The payment cannot proceed."} No funds are collected.`;
    if(type.includes("SETTL")) return `${sender} sends settlement information to ${recipient}. The participants reconcile the cleared obligation and credit the merchant after fees.`;
    if(type.includes("CLEAR")) return `${sender} sends the captured payment to ${recipient} for clearing. The issuer replaces its hold with a posted debit and records the amount owed for settlement.`;
    if(type.includes("CAPTURE")) return `${sender} confirms the full ${amount} purchase to ${recipient}. The payment is ready for clearing; the authorization hold remains.`;
    return `${sender} sends ${amount === "—" ? "a payment message" : "the "+amount+" payment message"} to ${recipient}. This event was emitted by a running Python process.`;
  }

  function animateNext() {
    if(animationRunning || !animationQueue.length) return;
    const event = animationQueue.shift();
    const from = roleIndex(event.sender), to = roleIndex(event.recipient);
    const generation = animationGeneration;
    if(!points.length) positionRails();
    const response = (from>=0 && to>=0 && from>to) || String(event.type).includes("RESULT") || String(event.type).includes("RESPONSE");
    const activityClass = response ? "active-response" : "active-request";
    document.querySelectorAll(".agent-card").forEach(card => card.classList.remove("active-request","active-response"));
    document.querySelectorAll(".rail-link").forEach(link => link.classList.remove("active"));
    if(from>=0) $("agent-"+roles[from].id).classList.add(activityClass);
    if(to>=0) $("agent-"+roles[to].id).classList.add(activityClass);
    if(from>=0 && to>=0 && Math.abs(from-to)===1) $("link-"+Math.min(from,to))?.classList.add("active");
    $("live-message-text").textContent = `${roleLabel(event.sender)} → ${roleLabel(event.recipient)} · ${readable(event.type)}${Number.isFinite(event.amount_cents) ? " · "+money(event.amount_cents) : ""}${event.outcome ? " · "+readable(event.outcome) : ""}`;
    $("live-message-seq").textContent = "#"+event.seq;
    if(!eventSelectionLocked && (!userSelectedPayment || event.payment_id===selectedPayment)) {
      selectedEvent = event;
      renderInspector();
    }
    animationRunning = true;
    const duration = reducedMotion.matches ? 0 : Math.min(430, Math.max(100, (state?.speed_ms || 650) * .6), animationQueue.length > 12 ? 100 : 430);
    const finish = () => {
      if(generation!==animationGeneration) return;
      setPacketVisible(false);
      animationRunning = false;
      // Yield between observations even with reduced motion; no invented events.
      setTimeout(animateNext, reducedMotion.matches ? 0 : 30);
    };
    if(from<0 || to<0 || !duration) { finish(); return; }
    const source=points[from], target=points[to];
    const packet=$("packet"), halo=$("packet-halo");
    setPacketVisible(true);
    packet.setAttribute("fill",response ? "#e8b86e" : "#78edca");
    halo.setAttribute("fill",response ? "#e8b86e33" : "#5ee0c033");
    const started=performance.now();
    function frame(now) {
      if(generation!==animationGeneration) return;
      const fraction=Math.min((now-started)/duration,1);
      const x=source.x+(target.x-source.x)*fraction, y=source.y+(target.y-source.y)*fraction;
      packet.setAttribute("cx",x);packet.setAttribute("cy",y);halo.setAttribute("cx",x);halo.setAttribute("cy",y);
      if(fraction<1) requestAnimationFrame(frame); else finish();
    }
    requestAnimationFrame(frame);
  }

  function renderAgents() {
    let aliveCount=0;
    for(const role of roles) {
      const agent=state.agents?.find(candidate => canonicalRole(candidate.id)===role.id);
      const alive=Boolean(agent?.alive);
      aliveCount += Number(alive);
      $("alive-"+role.id).classList.toggle("alive",alive);
      $("agent-"+role.id).classList.toggle("dead",Boolean(agent && !alive));
      $("pid-"+role.id).textContent="PID "+(agent?.pid || "—");
      $("counts-"+role.id).textContent=`↓${agent?.received || 0} ↑${agent?.sent || 0}`;
      const activity=agent?.last_activity;
      $("activity-"+role.id).textContent=typeof activity==="string" && activity ? activity : alive ? "Listening for messages" : "Process unavailable";
      $("activity-"+role.id).title=$("activity-"+role.id).textContent;
    }
    $("process-count").textContent=`${aliveCount} / 6 online`;
  }

  function renderBalances() {
    const balances=state.balances || {};
    for(const [id,key] of [["posted","posted_cents"],["held","held_cents"],["available","available_cents"],["pending-settlement","pending_settlement_cents"],["merchant","merchant_cents"],["interchange","interchange_cents"],["network-fee","network_fee_cents"],["processing-fee","processing_fee_cents"]]) $(id).textContent=money(balances[key]);
  }

  function selectedRecord() { return state?.payments?.find(payment => payment.payment_id===selectedPayment); }

  function choosePayment(paymentId) {
    selectedPayment=paymentId;
    userSelectedPayment=true;
    eventSelectionLocked=false;
    selectedEvent=[...events].reverse().find(event => event.payment_id===paymentId) || null;
    renderedPaymentsKey="";renderedEventsKey="";
    renderPayments();renderEvents();renderInspector();renderLifecycle();updateControls();
  }

  function renderPayments() {
    const payments=state?.payments || [];
    const key=JSON.stringify(payments)+selectedPayment;
    $("transaction-count").textContent=payments.length;
    $("empty-transactions").hidden=payments.length>0;
    if(key!==renderedPaymentsKey) {
      renderedPaymentsKey=key;
      $("payments-body").innerHTML=[...payments].reverse().map(payment => `<tr class="${payment.payment_id===selectedPayment ? "selected" : ""}" data-payment="${escapeHTML(payment.payment_id)}"><td><button class="payment-select" type="button" data-payment="${escapeHTML(payment.payment_id)}" aria-label="Inspect ${escapeHTML(payment.payment_id)}" aria-pressed="${payment.payment_id===selectedPayment}"><b class="mono">${escapeHTML(payment.payment_id)}</b><small>${escapeHTML(payment.network || "Card network")} · ${escapeHTML(payment.account_id || "Fictional account")}</small></button></td><td class="amount-cell">${money(payment.amount_cents)}</td><td><span class="state-badge ${escapeHTML(String(payment.status||"").toLowerCase())}" title="${escapeHTML(payment.reason || "")}">${escapeHTML(readable(payment.status))}</span></td></tr>`).join("");
    }
    const selected=selectedRecord();
    $("selected-payment-label").textContent=selected ? `${selected.payment_id} · ${selected.batch_id || "no batch yet"}` : "No transaction selected";
    const account=state?.account_balances?.[selected?.account_id];
    $("selected-account").hidden=!selected;
    $("selected-account").innerHTML=account ? `<span class="account-caption">SELECTED PAYER</span><b>${escapeHTML(account.name || selected.account_id)}</b><span>Posted <b>${money(account.posted_cents)}</b></span><span>Held <b>${money(account.held_cents)}</b></span><span>Available <b>${money(account.available_cents)}</b></span>${account.active ? "" : "<span>Inactive account</span>"}` : selected ? `<span class="account-caption">SELECTED PAYER</span><b>${escapeHTML(selected.account_id)}</b><span>${state.accounts?.[selected.account_id] ? "Fictional account" : "Token has no matching account"}</span>` : "";
  }

  function renderLifecycle() {
    const status=String(selectedRecord()?.status || "").toUpperCase();
    const steps=["authorize","capture","clear","settle"];
    const progression={QUEUED:0,PENDING:0,AUTH_PENDING:0,AUTHORIZED:0,CAPTURE_PENDING:1,CAPTURED:1,CLEAR_PENDING:2,CLEARED:2,SETTLING:3,SETTLED:3};
    steps.forEach((name,index) => {
      const element=$("life-"+name);
      const progress=progression[status];
      element.classList.toggle("current",progress===index);
      element.classList.toggle("complete",Number.isFinite(progress) && (index<progress || status==="SETTLED"));
    });
    const notes={
      QUEUED:"The purchase is queued at the payer. Advance each real message to see the complete authorization journey.",
      PENDING:"The purchase is traveling to the issuer. Advance each message to see where it goes.",
      AUTH_PENDING:"The purchase is traveling to the issuer. Advance each message to see where it goes.",
      AUTHORIZED:"Approved: the issuer holds funds. The posted balance is unchanged. Capture confirms that the merchant wants to collect.",
      CAPTURED:"Captured: the merchant confirmed collection. The hold remains until clearing posts the debit.",
      CLEARED:"Cleared: the issuer replaced the hold with a posted debit. The obligation awaits settlement.",
      SETTLING:"Settlement messages are in flight. The merchant is credited only after the participants reconcile the batch.",
      SETTLED:"Settled: the payer paid the full purchase amount. Merchant proceeds plus the fee allocations equal that amount.",
      DECLINED:"Declined: the issuer sent a reason back through the same chain. No hold, posted debit, or merchant credit is created."
    };
    $("teaching-note").textContent=notes[status] || "Authorization is a promise to pay. Follow the later stages to see the posted debit and merchant credit.";
  }

  function renderInspector() {
    const event=selectedEvent;
    $("event-number").textContent=event ? "#"+event.seq : "—";
    $("message-route").innerHTML=event ? `<b>${escapeHTML(roleLabel(event.sender))}</b><span class="arrow" aria-hidden="true">→</span><b>${escapeHTML(roleLabel(event.recipient))}</b>` : "<span>Waiting for a message</span>";
    $("event-type").textContent=event ? readable(event.type).toUpperCase() : "READY TO EXPLORE";
    $("explanation").textContent=event ? eventExplanation(event) : "Six independent programs are ready. A purchase starts with the payer, travels to the issuer, and brings an approval or decline back to the checkout.";
    $("event-facts").innerHTML=event ? [event.payment_id ? `<span>Payment <b class="mono">${escapeHTML(event.payment_id)}</b></span>` : "",Number.isFinite(event.amount_cents) ? `<span>Amount <b>${money(event.amount_cents)}</b></span>` : "",event.outcome ? `<span>Outcome <b>${escapeHTML(readable(event.outcome))}</b></span>` : "",event.reason ? `<span>Reason <b>${escapeHTML(readable(event.reason))}</b></span>` : ""].join("") : "";
    $("event-json").textContent=JSON.stringify(event || {},null,2);
  }

  function renderEvents() {
    const visible=events.filter(event => $("event-filter").value!=="selected" || event.payment_id===selectedPayment).slice(-100).reverse();
    const key=visible.map(event=>event.seq).join(",")+":"+selectedEvent?.seq+":"+$("event-filter").value;
    $("events-count").textContent=events.length;
    if(key===renderedEventsKey) return;
    renderedEventsKey=key;
    $("events-list").innerHTML=visible.length ? visible.map(event => `<button type="button" class="event-row ${event.seq===selectedEvent?.seq ? "selected" : ""}" data-event="${event.seq}" aria-label="Inspect event ${event.seq}: ${escapeHTML(readable(event.type))}" aria-pressed="${event.seq===selectedEvent?.seq}"><span class="event-seq">#${event.seq}</span><span class="event-time">${escapeHTML(eventTime(event))}</span><span class="event-path">${escapeHTML(roleLabel(event.sender))}<i>→</i>${escapeHTML(roleLabel(event.recipient))}</span><span class="event-description">${escapeHTML(eventExplanation(event))}</span><span class="event-payment">${escapeHTML(event.payment_id || "system")}</span></button>`).join("") : `<p class="event-empty">${$("event-filter").value==="selected" ? "No events for this payment yet." : "The message trail will appear here. Select any event to read its envelope."}</p>`;
  }

  function updateControls() {
    const failed=Boolean(state?.fault);
    const blocked=!connected || pendingCommand || failed;
    const selected=selectedRecord();
    const guided=state?.mode!=="automatic";
    $("guided-mode").classList.toggle("active",guided);
    $("guided-mode").setAttribute("aria-pressed",guided);
    $("automatic-mode").classList.toggle("active",!guided);
    $("automatic-mode").setAttribute("aria-pressed",!guided);
    $("mode-help").textContent=guided ? "Advance one real message at a time." : "Seeded POS purchases run through the complete lifecycle.";
    $("pending-count").textContent=`${state?.pending_count || 0} queued`;
    for(const id of ["purchase","guided-mode","automatic-mode","speed","pause","preset","amount","network","seed"]) $(id).disabled=blocked;
    $("step").disabled=blocked || !guided || !state?.pending_count;
    $("capture").disabled=blocked || String(selected?.status).toUpperCase()!=="AUTHORIZED";
    $("clear").disabled=blocked || !(state?.payments || []).some(payment=>String(payment.status).toUpperCase()==="CAPTURED");
    $("settle").disabled=blocked || !(state?.payments || []).some(payment=>String(payment.status).toUpperCase()==="CLEARED");
    $("replay").disabled=blocked || !selected || ["AUTH_PENDING","QUEUED","PENDING"].includes(String(selected.status).toUpperCase());
    $("reset").disabled=!connected || pendingCommand;
    $("pause").innerHTML=state?.paused ? '<span aria-hidden="true">▷</span> Resume' : '<span aria-hidden="true">Ⅱ</span> Pause';
    $("pause").setAttribute("aria-label",state?.paused ? "Resume automatic messages" : "Pause automatic messages");
    if(state && document.activeElement!==$("seed")) $("seed").value=state.seed ?? 42;
    if(state && document.activeElement!==$("speed")) {
      const value=String(state.speed_ms || 650);
      if([...$("speed").options].some(option=>option.value===value)) $("speed").value=value;
    }
  }

  function applyState(next) {
    if(next.session_id!==session) resetSession(next.session_id);
    state=next;
    const fresh=(next.events || []).filter(event=>Number(event.seq)>lastSeq).sort((a,b)=>a.seq-b.seq);
    if(fresh.length) {
      events=events.concat(fresh).slice(-1000);
      lastSeq=Math.max(lastSeq,...fresh.map(event=>Number(event.seq)));
      animationQueue.push(...fresh);
      if(!userSelectedPayment) selectedPayment=[...fresh].reverse().find(event=>
        next.payments?.some(payment=>payment.payment_id===event.payment_id))?.payment_id || selectedPayment;
    }
    // Advance the cursor only for events received. A different browser can reset
    // the server while this browser still has the preceding session's cursor.
    if(!selectedPayment && state.payments?.length) selectedPayment=state.payments[state.payments.length-1].payment_id;
    const alive=(state.agents || []).filter(agent=>agent.alive).length;
    setConnection(true,state.fault ? "Process failure · reset required" : `${alive} independent processes connected`);
    showNotice(state.fault ? `Demonstration paused: ${state.fault}. Reset to start six fresh processes.` : null);
    renderAgents();renderBalances();renderPayments();renderLifecycle();renderEvents();updateControls();
    animateNext();
  }

  async function fetchState() {
    if(pollInProgress) return;
    pollInProgress=true;
    try {
      const response=await fetch(`/api/state?after=${lastSeq}`,{cache:"no-store",signal:AbortSignal.timeout(5000)});
      if(!response.ok) throw new Error(`State request failed (${response.status})`);
      applyState(await response.json());
    } catch(error) {
      setConnection(false,"Connection interrupted · retrying");
      showNotice("The supervisor is not responding. The displayed values are the last observed state. Start the Python program or wait for reconnection.");
    } finally { pollInProgress=false; }
  }

  async function poll() {
    await fetchState();
    setTimeout(poll,250);
  }

  async function command(payload, successMessage) {
    if(pendingCommand) return;
    pendingCommand=true;updateControls();
    try {
      const response=await fetch("/api/command",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
      const result=await response.json();
      if(!response.ok || result.error) throw new Error(result.error || `Command failed (${response.status})`);
      if(successMessage) toast(successMessage);
      if(payload.action==="purchase") {userSelectedPayment=false;eventSelectionLocked=false;}
      // The response may contain a full state; otherwise the next poll observes it.
      if(result.session_id && result.agents) applyState(result);
      else if(result.state?.session_id) applyState(result.state);
      await fetchState();
    } catch(error) {toast(error.message || "The command could not be completed.",true);}
    finally {pendingCommand=false;updateControls();}
  }

  $("purchase-form").addEventListener("submit",event=>{
    event.preventDefault();
    if(!$("purchase-form").reportValidity()) return;
    const amount_cents=Math.round(Number($("amount").value)*100);
    if(!Number.isSafeInteger(amount_cents) || amount_cents<100 || amount_cents>1000000) {toast("Enter an amount from $1.00 to $10,000.00.",true);return;}
    command({action:"purchase",preset:$("preset").value,amount_cents,network:$("network").value},"Purchase sent. Follow the message to the issuer.");
  });
  $("step").addEventListener("click",()=>command({action:"step"}));
  $("preset").addEventListener("change",()=>{
    $("amount").value=$("preset").value==="insufficient" ? "600.00" : "50.00";
    $("network").value=["insufficient","invalid"].includes($("preset").value) ? "Mastercard" : "Visa";
  });
  $("capture").addEventListener("click",()=>command({action:"capture",payment_id:selectedPayment},"Capture requested for the selected payment."));
  $("clear").addEventListener("click",()=>command({action:"clear"},"Clearing batch requested."));
  $("settle").addEventListener("click",()=>command({action:"settle"},"Settlement batch requested."));
  $("guided-mode").addEventListener("click",()=>command({action:"mode",mode:"guided"}));
  $("automatic-mode").addEventListener("click",()=>command({action:"mode",mode:"automatic"},"Automatic mode: seeded purchases and accelerated batches."));
  $("pause").addEventListener("click",()=>command({action:"pause",paused:!state?.paused}));
  $("speed").addEventListener("change",()=>command({action:"speed",speed_ms:Number($("speed").value)}));
  $("reset").addEventListener("click",()=>{
    const seed=Number($("seed").value);
    if(!Number.isSafeInteger(seed) || seed<0 || seed>2147483647) {toast("Choose a whole-number seed from 0 to 2,147,483,647.",true);return;}
    command({action:"reset",seed},"Reset complete. All six programs start fresh.");
  });
  $("replay").addEventListener("click",()=>command({action:"replay",payment_id:selectedPayment},"The same authorization is being repeated. Watch the recorded result return."));
  $("payments-body").addEventListener("click",event=>{
    const row=event.target.closest("[data-payment]");
    if(row) choosePayment(row.dataset.payment);
  });
  $("events-list").addEventListener("click",event=>{
    const row=event.target.closest("[data-event]");
    if(!row) return;
    const record=events.find(candidate=>String(candidate.seq)===row.dataset.event);
    if(!record) return;
    selectedEvent=record;eventSelectionLocked=true;
    if(record.payment_id) {selectedPayment=record.payment_id;userSelectedPayment=true;}
    renderedEventsKey="";renderedPaymentsKey="";
    renderInspector();renderEvents();renderPayments();renderLifecycle();updateControls();
    $("announcer").textContent=`Event ${record.seq}. ${eventExplanation(record)}`;
  });
  $("event-filter").addEventListener("change",()=>{renderedEventsKey="";renderEvents();});
  document.addEventListener("keydown",event=>{
    if(event.ctrlKey || event.metaKey || event.altKey || event.target.closest("input,select,textarea,button,summary,a,[contenteditable]")) return;
    const button=event.code==="Space" ? $("pause") : event.key.toLowerCase()==="n" ? $("step") : event.key.toLowerCase()==="c" ? $("capture") : null;
    if(button && !button.disabled) {event.preventDefault();button.click();}
  });
  const resizeObserver=new ResizeObserver(positionRails);
  resizeObserver.observe($("rail-stage"));
  reducedMotion.addEventListener("change",animateNext);
  positionRails();updateControls();poll();
})();
