#!/usr/bin/env python3
"""
Script de setup do n8n em produção.
Executa APÓS docker compose up -d n8n.
Cria usuário admin, credenciais e importa workflows.

Uso: python3 scripts/setup-n8n-prod.py --url http://localhost:5678
"""
import argparse, json, time, requests, os, sys

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://localhost:5678', help='URL do n8n')
    parser.add_argument('--email', default='admin@bcmtech.com.br')
    parser.add_argument('--workflows-dir', default='n8n-workflows')
    args = parser.parse_args()

    BASE = args.url
    GEMINI_KEY = os.environ.get('GEMINI_API_KEY', '')
    REDIS_HOST = os.environ.get('REDIS_HOST', 'redis')
    N8N_AGENT_KEY = os.environ.get('N8N_AGENT_KEY', '')

    if not GEMINI_KEY:
        print("ERRO: defina GEMINI_API_KEY como env var")
        sys.exit(1)

    # 1. Wait for n8n
    print("Aguardando n8n iniciar...")
    for _ in range(30):
        try:
            r = requests.get(f"{BASE}/healthz", timeout=3)
            if r.status_code == 200:
                break
        except:
            pass
        time.sleep(2)
    else:
        print("ERRO: n8n não respondeu em 60s")
        sys.exit(1)
    print("n8n online!")

    # 2. Setup owner
    # A senha do owner do n8n de producao estava LITERAL neste arquivo, que e
    # rastreado no git. A UI do n8n fica publicada na porta 5678 e o compose de
    # producao usa N8N_BLOCK_ENV_ACCESS_IN_NODE=false, entao quem loga la le
    # todas as variaveis de ambiente por dentro de um Code node — incluindo
    # N8N_AGENT_KEY e WAHA_API_KEY. Agora vem do ambiente.
    # A SENHA ANTIGA PRECISA SER ROTACIONADA: tirar do arquivo nao apaga o
    # historico do git.
    n8n_password = os.environ.get("N8N_OWNER_PASSWORD")
    if not n8n_password:
        print("ERRO: defina N8N_OWNER_PASSWORD no ambiente antes de rodar este script.")
        sys.exit(1)
    print("Configurando admin...")
    r = requests.post(f"{BASE}/rest/owner/setup",
        json={"email": args.email, "firstName": "Admin", "lastName": "BCM", "password": n8n_password},
        headers={"Content-Type": "application/json"})
    if r.status_code not in (200, 400):
        print(f"Aviso setup owner: {r.text[:100]}")

    # 3. Login
    session = requests.Session()
    r = session.post(f"{BASE}/rest/login",
        json={"emailOrLdapLoginId": args.email, "password": n8n_password},
        headers={"Content-Type": "application/json"})
    if r.status_code != 200:
        print(f"ERRO login: {r.text[:200]}")
        sys.exit(1)
    print("Login OK")

    # 4. Create API key
    r = session.post(f"{BASE}/rest/api-keys",
        json={"label": "automation", "scopes": ["workflow:list","workflow:read","workflow:create","workflow:update","workflow:activate","workflow:delete"], "expiresAt": None},
        headers={"Content-Type": "application/json"})
    api_key = r.json().get('data', {}).get('rawApiKey', '') if r.status_code == 200 else ''
    if not api_key:
        print(f"Aviso API key: {r.text[:100]}")
    else:
        print(f"API key criada: {api_key[:20]}...")

    api_headers = {"X-N8N-API-KEY": api_key, "Content-Type": "application/json"} if api_key else {}

    # 5. Create credentials
    print("Criando credenciais...")
    r = session.post(f"{BASE}/rest/credentials",
        json={"name": "Redis Shopping", "type": "redis", "data": {"host": REDIS_HOST, "port": 6379, "ssl": False}, "nodesAccess": []},
        headers={"Content-Type": "application/json"})
    redis_cred_id = r.json().get('data', {}).get('id', '') if r.status_code == 200 else ''
    print(f"Redis cred: {redis_cred_id}")

    r = session.post(f"{BASE}/rest/credentials",
        json={"name": "Google Gemini", "type": "googlePalmApi", "data": {"host": "https://generativelanguage.googleapis.com", "apiKey": GEMINI_KEY}, "nodesAccess": []},
        headers={"Content-Type": "application/json"})
    gemini_cred_id = r.json().get('data', {}).get('id', '') if r.status_code == 200 else ''
    print(f"Gemini cred: {gemini_cred_id}")

    if not (redis_cred_id and gemini_cred_id):
        print("ERRO: falha ao criar credenciais")
        sys.exit(1)

    # 6. Import workflows
    print("\nImportando workflows...")
    created_ids = {}
    wf_order = ['vendor_agent.json', 'customer_agent.json', 'waha_router.json']

    for fname in wf_order:
        fpath = os.path.join(args.workflows_dir, fname)
        if not os.path.exists(fpath):
            print(f"Arquivo não encontrado: {fpath}")
            continue

        with open(fpath) as f:
            wf = json.load(f)

        # Remove active field and id (will be assigned)
        wf.pop('active', None)
        wf.pop('id', None)
        wf.pop('createdAt', None)
        wf.pop('updatedAt', None)

        # Add credentials to nodes
        for node in wf.get('nodes', []):
            ntype = node.get('type', '')
            if 'lmChatGoogleGemini' in ntype:
                node['credentials'] = {'googlePalmApi': {'id': gemini_cred_id, 'name': 'Google Gemini'}}
            elif 'memoryRedisChat' in ntype:
                node['credentials'] = {'redis': {'id': redis_cred_id, 'name': 'Redis Shopping'}}

        payload = {'name': wf['name'], 'nodes': wf['nodes'], 'connections': wf['connections'], 'settings': wf.get('settings', {})}

        if api_key:
            r = requests.post(f"{BASE}/api/v1/workflows", headers=api_headers, json=payload)
        else:
            r = session.post(f"{BASE}/rest/workflows", json=payload, headers={"Content-Type": "application/json"})

        if r.status_code in (200, 201):
            wid = r.json().get('id', '')
            created_ids[wf['name']] = wid
            print(f"  Criado: {wf['name']} -> {wid}")
        else:
            print(f"  ERRO {wf['name']}: {r.text[:200]}")

    # 7. Update router to use correct workflow IDs
    vendor_id = created_ids.get('Vendor Agent', '')
    customer_id = created_ids.get('Customer Agent', '')
    router_id = created_ids.get('WAHA Router', '')

    if router_id and vendor_id and customer_id and api_key:
        wf = requests.get(f"{BASE}/api/v1/workflows/{router_id}", headers=api_headers).json()
        for node in wf.get('nodes', []):
            if node['name'] == 'Call Vendor Agent':
                node['parameters']['workflowId'] = {'__rl': True, 'mode': 'id', 'value': vendor_id}
            elif node['name'] == 'Call Customer Agent':
                node['parameters']['workflowId'] = {'__rl': True, 'mode': 'id', 'value': customer_id}
        payload = {'name': wf['name'], 'nodes': wf['nodes'], 'connections': wf['connections'], 'settings': wf.get('settings', {})}
        requests.put(f"{BASE}/api/v1/workflows/{router_id}", headers=api_headers, json=payload)
        print(f"Router atualizado com IDs corretos")

    # 8. Fix trigger nodes and activate
    if api_key:
        for name, wid in [('Vendor Agent', vendor_id), ('Customer Agent', customer_id)]:
            if not wid: continue
            wf = requests.get(f"{BASE}/api/v1/workflows/{wid}", headers=api_headers).json()
            for node in wf.get('nodes', []):
                if node.get('type') == 'n8n-nodes-base.executeWorkflowTrigger':
                    node.setdefault('parameters', {})['inputSource'] = 'passthrough'
            payload = {'name': wf['name'], 'nodes': wf['nodes'], 'connections': wf['connections'], 'settings': wf.get('settings', {})}
            requests.put(f"{BASE}/api/v1/workflows/{wid}", headers=api_headers, json=payload)

        # Publish via CLI then activate
        import subprocess
        for wid in [vendor_id, customer_id, router_id]:
            if wid:
                subprocess.run(['docker', 'exec', 'shopping-n8n', 'n8n', 'publish:workflow', f'--id={wid}'], capture_output=True)
        print("Workflows publicados via CLI")

        # Activate
        for name, wid in [('Vendor Agent', vendor_id), ('Customer Agent', customer_id), ('WAHA Router', router_id)]:
            if not wid: continue
            r = requests.post(f"{BASE}/api/v1/workflows/{wid}/activate", headers=api_headers)
            status = 'OK' if r.status_code == 200 else f'ERRO {r.text[:100]}'
            print(f"  Ativado {name}: {status}")

    print("\n=== SETUP COMPLETO ===")
    print(f"n8n UI: {BASE}")
    print(f"Webhook WAHA: {BASE}/webhook/waha-message")
    print(f"\nProximo passo: configurar WAHA para enviar webhooks para:")
    print(f"  WHATSAPP_HOOK_URL={BASE}/webhook/waha-message")

if __name__ == '__main__':
    main()
