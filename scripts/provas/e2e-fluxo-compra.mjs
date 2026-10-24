// E2E bcmTech — ciclo compra/venda/entrega contra a API local (localhost:3000).
// Nível 1 (simulatePayment): exercita toda a máquina de estados sem tocar dinheiro.
// Também valida os fixes da auditoria 2026-08-23.
const URL = 'http://localhost:3000/graphql';
const ok = [], fail = [];
function check(cond, name, detail='') { (cond?ok:fail).push(name+(detail?` — ${detail}`:'')); console.log(`${cond?'✅':'❌'} ${name}${detail?' — '+detail:''}`); }

async function gql(query, token, variables) {
  const r = await fetch(URL, { method:'POST', headers:{'Content-Type':'application/json', ...(token?{Authorization:`Bearer ${token}`}:{})}, body: JSON.stringify({query, variables}) });
  const j = await r.json();
  return j;
}
async function must(query, token, path, variables) {
  const j = await gql(query, token, variables);
  if (j.errors) throw new Error(`${path}: ${j.errors[0].message}`);
  return j.data;
}
function cpf() { // gera CPF válido
  const n = Array.from({length:9},()=>Math.floor(Math.random()*10));
  const d = (arr)=>{ let s=0; for(let i=0;i<arr.length;i++) s+=arr[i]*(arr.length+1-i); const r=11-(s%11); return r>=10?0:r; };
  const d1=d(n); const d2=d([...n,d1]); return [...n,d1,d2].join('');
}
const ts = Date.now();
let sup, V1, V2, C1, D1;

// ---- SQL helper via docker ----
import { execSync } from 'node:child_process';
import { RECEBEDOR_VENDEDOR, RECEBEDOR_ENTREGADOR } from './recebedores-de-teste.mjs';
function sql(q){ return execSync(`docker exec shopping-postgres psql -U shopping -d shopping_db -tAc "${q.replace(/"/g,'\\"')}"`,{encoding:'utf8'}).trim(); }

const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function login(email, pw='teste123', kind='app') {
  const m = kind==='vendor'?'loginVendor':'loginApp';
  for (let attempt=0; attempt<6; attempt++) {
    const j = await gql(`mutation{ ${m}(input:{email:"${email}",password:"${pw}"}, forceLogin:true){ accessToken user{ id role } } }`);
    if (!j.errors) return j.data[m];
    if (/throttl|too many/i.test(j.errors[0].message)) { await sleep(1500*(attempt+1)); continue; }
    throw new Error('login '+email+': '+j.errors[0].message);
  }
  throw new Error('login '+email+': throttle persistente');
}

async function run() {
  // 0. superadmin
  sup = await login('superadmin@bcmtech.com'); check(sup.user.role==='SUPERADMIN','login superadmin');

  // 1. Vendedor V1 (loja com entrega por app)
  const vemail=`v1_${ts}@t.com`, vcpf=cpf();
  await must(`mutation{ registerVendor(input:{name:"Vend1",email:"${vemail}",password:"teste123",phone:"5391${String(ts).slice(-6)}",cpf:"${vcpf}"}){ accessToken } }`,null,'registerVendor');
  // Aprova o vendedor (KYC) + conecta recebimento sandbox direto no banco, ANTES do
  // login — assim o token já vem com role VENDOR. Evita chamada real de KYC ao Pagar.me.
  const vid0 = sql(`SELECT id FROM vendor_users WHERE email='${vemail}'`);
  sql(`UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, "pagarmeRecipientId"='${RECEBEDOR_VENDEDOR}' WHERE id='${vid0}'`);
  V1 = await login(vemail, "teste123", "vendor");
  const vid = V1.user.id;
  check(V1.user.role==='VENDOR','vendedor aprovado (role VENDOR)');
  check(sql(`SELECT "mpConnected" FROM vendor_users WHERE id='${vid}'`)==='t','vendedor paymentConnected (seed)');

  const st = await must(`mutation{ createStore(input:{name:"Loja E2E ${ts}",phone:"5391000",street:"Rua A",number:"1",neighborhood:"Centro",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:false,latitude:-31.77,longitude:-52.34}){ id hasOwnDelivery } }`,V1.accessToken,'createStore');
  const storeId=st.createStore.id; check(!!storeId,'createStore V1 (entrega app)');
  const cat = await must(`mutation{ createCategory(name:"Cat",storeId:"${storeId}"){ id } }`,V1.accessToken,'createCategory');
  const prod = await must(`mutation{ createProduct(input:{name:"Pizza",price:25.90,storeId:"${storeId}",categoryId:"${cat.createCategory.id}",stock:10}){ id stock } }`,V1.accessToken,'createProduct');
  const productId=prod.createProduct.id; check(prod.createProduct.stock===10,'produto criado stock=10');

  // 2. Cliente C1
  const cemail=`c1_${ts}@t.com`;
  await must(`mutation{ registerApp(input:{name:"Cli1",email:"${cemail}",password:"teste123",phone:"5392${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`,null,'registerApp C1');
  C1 = await login(cemail);

  // 3. Entregador D1
  const demail=`d1_${ts}@t.com`;
  await must(`mutation{ registerApp(input:{name:"Ent1",email:"${demail}",password:"teste123",phone:"5393${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`,null,'registerApp D1');
  D1 = await login(demail);
  await must(`mutation{ registerAsDeliverer(input:{vehicleType:"MOTO",birthDate:"1995-01-01",cnhNumber:"12345678900",profilePhotoUrl:"http://x/p.jpg",identityPhotoUrl:"http://x/i.jpg",identityPhotoBackUrl:"http://x/b.jpg"}){ id } }`,D1.accessToken,'registerAsDeliverer');
  await must(`mutation{ approveAppUser(id:"${D1.user.id}"){ id role } }`,sup.accessToken,'approveAppUser D1');
  D1 = await login(demail); // re-login pra pegar role DELIVERER no token
  check(D1.user.role==='DELIVERER','entregador aprovado (role DELIVERER)');
  sql(`UPDATE app_users SET "mpConnected"=true, "pagarmeRecipientId"='${RECEBEDOR_ENTREGADOR}' WHERE id='${D1.user.id}'`);

  // ===== FLUXO FELIZ =====
  console.log('\n--- FLUXO FELIZ (compra→venda→entrega→repasse) ---');
  const o = await must(`mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${productId}",quantity:2}],paymentMethod:"PIX",deliveryAddress:"Rua Cliente 50",deliveryLatitude:-31.76,deliveryLongitude:-52.33}){ id status total } }`,C1.accessToken,'createOrder');
  const orderId=o.createOrder.id; check(o.createOrder.status==='AWAITING_PAYMENT','pedido nasce AWAITING_PAYMENT');
  check(sql(`SELECT stock FROM products WHERE id='${productId}'`)==='8','estoque decrementou na criação (10→8)');

  await must(`mutation{ simulatePayment(orderId:"${orderId}"){ status } }`,sup.accessToken,'simulatePayment');
  check(sql(`SELECT status FROM orders WHERE id='${orderId}'`)==='PENDING','pagamento confirmado → PENDING');

  for (const s of ['ACCEPTED','PREPARING','READY']) await must(`mutation{ updateOrderStatus(id:"${orderId}",status:${s}){ status } }`,V1.accessToken,`updateOrderStatus ${s}`);
  check(sql(`SELECT status FROM orders WHERE id='${orderId}'`)==='READY','vendedor levou até READY');

  const av = await must(`query{ availableDeliveries{ id orderNumber } }`,D1.accessToken,'availableDeliveries');
  const orderNumber = sql(`SELECT "orderNumber" FROM orders WHERE id='${orderId}'`);
  check(av.availableDeliveries.some(d=>d.orderNumber===orderNumber),'pedido aparece em availableDeliveries');

  const del = await must(`mutation{ acceptDelivery(orderId:"${orderId}"){ id } }`,D1.accessToken,'acceptDelivery');
  const deliveryId=del.acceptDelivery.id;
  // CONFIRMAÇÃO POR CÓDIGOS (substituiu os botões neste fluxo).
  //
  // Pedido com entrega por entregador do app agora nasce com código, e os
  // botões antigos são recusados nele de propósito — ter dois caminhos capazes
  // de liberar o mesmo dinheiro é ter duas fontes de verdade, e a mais fraca
  // venceria. Retirada e frota própria não recebem código e seguem por botão.
  const cods = sql(`SELECT "codigoVendedor" || '|' || "codigoCliente" || '|' || COALESCE("codigoEntregador",'-') FROM orders WHERE id='${orderId}'`).split('|');
  check(/^\d{6}$/.test(cods[0]) && /^\d{6}$/.test(cods[1]),'pedido de entrega por app nasce com os códigos');
  check(/^\d{6}$/.test(cods[2]),'código do entregador gerado no aceite da corrida');

  // os botões antigos não podem contornar os códigos
  const botaoRecusado = await gql(`mutation{ confirmPickup(deliveryId:"${deliveryId}"){ id } }`,D1.accessToken);
  check(!!botaoRecusado.errors,'confirmPickup recusado em pedido com código');

  // coleta: troca mútua — o entregador digita o código da loja, o lojista o do entregador
  await must(`mutation{ registrarCodigoDaLoja(orderId:"${orderId}",codigo:"${cods[0]}",latitude:-31.77,longitude:-52.34){ status } }`,D1.accessToken,'registrarCodigoDaLoja');
  check(sql(`SELECT status FROM orders WHERE id='${orderId}'`)==='READY','com só um código do par, o pedido NÃO avança');
  await must(`mutation{ registrarCodigoDoEntregador(orderId:"${orderId}",codigo:"${cods[2]}"){ status } }`,V1.accessToken,'registrarCodigoDoEntregador');
  check(sql(`SELECT status FROM orders WHERE id='${orderId}'`)==='DELIVERING','par da coleta completo → DELIVERING');

  // entrega: o código do cliente libera o dinheiro
  await must(`mutation{ registrarCodigoDoCliente(orderId:"${orderId}",codigo:"${cods[1]}",latitude:-31.76,longitude:-52.33){ status } }`,D1.accessToken,'registrarCodigoDoCliente');
  check(sql(`SELECT status FROM orders WHERE id='${orderId}'`)==='COMPLETED','código do cliente → COMPLETED');
  check(sql(`SELECT "isSettled" FROM orders WHERE id='${orderId}'`)==='t','repasse disparado na liberação');

  // ===== FIX A4: autoentrega bloqueada =====
  console.log('\n--- FIX A4: autoentrega ---');
  const oSelf = await must(`mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${productId}",quantity:1}],paymentMethod:"PIX",deliveryAddress:"Rua D 1",deliveryLatitude:-31.76,deliveryLongitude:-52.33}){ id } }`,D1.accessToken,'createOrder (D1 como cliente)');
  await must(`mutation{ simulatePayment(orderId:"${oSelf.createOrder.id}"){ status } }`,sup.accessToken,'simulatePayment self');
  for (const s of ['ACCEPTED','PREPARING','READY']) await must(`mutation{ updateOrderStatus(id:"${oSelf.createOrder.id}",status:${s}){ status } }`,V1.accessToken,`self ${s}`);
  const selfAccept = await gql(`mutation{ acceptDelivery(orderId:"${oSelf.createOrder.id}"){ id } }`,D1.accessToken);
  check(!!selfAccept.errors && /próprio|proprio/i.test(selfAccept.errors[0].message),'autoentrega BLOQUEADA', selfAccept.errors?.[0]?.message||'aceitou (BUG!)');

  // ===== FIX C2: frota própria não é ofertada =====
  console.log('\n--- FIX C2: frota própria ---');
  // V2 — outro vendedor (plano FREE limita 1 loja por vendedor)
  const v2email=`v2_${ts}@t.com`;
  await must(`mutation{ registerVendor(input:{name:"Vend2",email:"${v2email}",password:"teste123",phone:"5394${String(ts).slice(-6)}",cpf:"${cpf()}"}){ accessToken } }`,null,'registerVendor V2');
  const v2id0 = sql(`SELECT id FROM vendor_users WHERE email='${v2email}'`);
  sql(`UPDATE vendor_users SET role='VENDOR', "approvedAt"=now(), "mpConnected"=true, "pagarmeRecipientId"='${RECEBEDOR_VENDEDOR}' WHERE id='${v2id0}'`);
  V2 = await login(v2email, "teste123", "vendor");
  const st2 = await must(`mutation{ createStore(input:{name:"Loja Own ${ts}",phone:"5391",street:"R",number:"2",neighborhood:"C",city:"Pelotas",state:"RS",zipCode:"96000000",hasOwnDelivery:true,latitude:-31.77,longitude:-52.34}){ id } }`,V2.accessToken,'createStore V2 own-delivery');
  const cat2 = await must(`mutation{ createCategory(name:"Cat2",storeId:"${st2.createStore.id}"){ id } }`,V2.accessToken,'createCategory2');
  const prod2 = await must(`mutation{ createProduct(input:{name:"Burg",price:20,storeId:"${st2.createStore.id}",categoryId:"${cat2.createCategory.id}",stock:10}){ id } }`,V2.accessToken,'createProduct2');
  const oOwn = await must(`mutation{ createOrder(input:{storeId:"${st2.createStore.id}",items:[{productId:"${prod2.createProduct.id}",quantity:1}],paymentMethod:"PIX",deliveryAddress:"R 9",deliveryLatitude:-31.76,deliveryLongitude:-52.33}){ id } }`,C1.accessToken,'createOrder own-delivery');
  await must(`mutation{ simulatePayment(orderId:"${oOwn.createOrder.id}"){ status } }`,sup.accessToken,'simulatePayment own');
  for (const s of ['ACCEPTED','PREPARING','READY']) await must(`mutation{ updateOrderStatus(id:"${oOwn.createOrder.id}",status:${s}){ status } }`,V2.accessToken,`own ${s}`);
  const ownNum = sql(`SELECT "orderNumber" FROM orders WHERE id='${oOwn.createOrder.id}'`);
  const av2 = await must(`query{ availableDeliveries{ orderNumber } }`,D1.accessToken,'availableDeliveries own');
  check(!av2.availableDeliveries.some(d=>d.orderNumber===ownNum),'pedido de frota própria NÃO ofertado');
  const ownAccept = await gql(`mutation{ acceptDelivery(orderId:"${oOwn.createOrder.id}"){ id } }`,D1.accessToken);
  check(!!ownAccept.errors && /própri|propri/i.test(ownAccept.errors[0].message),'aceite direto de frota própria BLOQUEADO', ownAccept.errors?.[0]?.message||'aceitou (BUG!)');

  // ===== FIX A3: double restore =====
  console.log('\n--- FIX A3: restauração de estoque única no cancelamento ---');
  const stockBefore = Number(sql(`SELECT stock FROM products WHERE id='${productId}'`));
  const oCancel = await must(`mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${productId}",quantity:3}],paymentMethod:"PIX",deliveryAddress:"R 1",deliveryLatitude:-31.76,deliveryLongitude:-52.33}){ id } }`,C1.accessToken,'createOrder p/ cancelar');
  check(Number(sql(`SELECT stock FROM products WHERE id='${productId}'`))===stockBefore-3,'estoque -3 na criação');
  await must(`mutation{ cancelOrder(orderId:"${oCancel.createOrder.id}"){ status } }`,C1.accessToken,'cancelOrder').catch(async()=>{
    // fallback nome da mutation
    await must(`mutation{ cancelByCustomer(orderId:"${oCancel.createOrder.id}"){ status } }`,C1.accessToken,'cancelByCustomer');
  });
  const restored = Number(sql(`SELECT stock FROM products WHERE id='${productId}'`));
  check(restored===stockBefore,'estoque restaurado exatamente 1x após cancelamento', `antes=${stockBefore} depois=${restored}`);
  check(sql(`SELECT "stockRestoredAt" IS NOT NULL FROM orders WHERE id='${oCancel.createOrder.id}'`)==='t','stockRestoredAt fincado (claim)');

  // ===== FIX C1: webhook payment_failed tardio não cancela pedido pago =====
  console.log('\n--- FIX C1: webhook tardio não cancela pedido pago ---');
  const oPaid = await must(`mutation{ createOrder(input:{storeId:"${storeId}",items:[{productId:"${productId}",quantity:1}],paymentMethod:"PIX",deliveryAddress:"R 1",deliveryLatitude:-31.76,deliveryLongitude:-52.33}){ id } }`,C1.accessToken,'createOrder p/ webhook tardio');
  await must(`mutation{ simulatePayment(orderId:"${oPaid.createOrder.id}"){ status } }`,sup.accessToken,'simulatePayment paid');
  const pid = oPaid.createOrder.id;
  // dispara webhook charge.payment_failed TARDIO com Basic Auth local
  const whUser = execSync(`docker exec shopping-api printenv PAGARME_WEBHOOK_USER`,{encoding:'utf8'}).trim();
  const whPass = execSync(`docker exec shopping-api printenv PAGARME_WEBHOOK_PASS`,{encoding:'utf8'}).trim();
  const basic = Buffer.from(`${whUser}:${whPass}`).toString('base64');
  const whr = await fetch('http://localhost:3000/payments/webhook',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Basic ${basic}`},body:JSON.stringify({type:'charge.payment_failed',data:{id:'ch_late_'+ts,metadata:{order_id:pid}}})});
  const statusAfter = sql(`SELECT status FROM orders WHERE id='${pid}'`);
  check(statusAfter==='PENDING',`pedido pago continua PENDING após webhook payment_failed tardio (webhook HTTP ${whr.status})`, `status=${statusAfter}`);

  console.log(`\n===== RESULTADO: ${ok.length} OK, ${fail.length} FALHOU =====`);
  if (fail.length) { console.log('FALHAS:'); fail.forEach(f=>console.log('  ❌ '+f)); process.exit(1); }
}
run().catch(e=>{ console.error('\n💥 ERRO FATAL:', e.message); process.exit(2); });
