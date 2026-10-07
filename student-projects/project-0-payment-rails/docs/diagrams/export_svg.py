"""Export slide-ready, editable SVG companions using only the standard library.
Mermaid files are the flow/sequence sources; these explicit SVG coordinates keep
classroom exports stable without requiring a Mermaid runtime.
"""
from pathlib import Path
from html import escape

OUT = Path(__file__).resolve().parent
NAVY, TEAL, PALE, MUTED, LINE, AMBER, RED = '#15384A', '#007D82', '#EDF5F5', '#536773', '#CCD8DD', '#926300', '#9A3232'


def start(title, desc, width, height):
    return [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">',
            f'<title id="title">{escape(title)}</title><desc id="desc">{escape(desc)}</desc>',
            '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#007D82"/></marker><marker id="return" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#926300"/></marker></defs>',
            '<rect width="100%" height="100%" fill="white"/>',
            f'<style>text{{font-family:Arial,Helvetica,sans-serif;fill:{NAVY}}}.label{{font-size:20px;font-weight:700}}.body{{font-size:17px}}.small{{font-size:15px;fill:{MUTED}}}.title{{font-size:32px;font-weight:700}}.eyebrow{{font-size:15px;font-weight:700;fill:{TEAL};letter-spacing:1px}}</style>',
            '<text class="eyebrow" x="35" y="35">USF • AI IN FINTECH • PROJECT 0</text>',
            f'<text class="title" x="35" y="83">{escape(title)}</text>']


def text(parts, x, y, lines, cls='body', anchor='middle', gap=27, color=None):
    extra = f' style="fill:{color}"' if color else ''
    for k, line in enumerate(lines):
        parts.append(f'<text class="{cls}" x="{x}" y="{y+k*gap}" text-anchor="{anchor}"{extra}>{escape(line)}</text>')


def box(parts, x, y, w, h, title, body=(), dashed=False, color=TEAL):
    dash = ' stroke-dasharray="7 5"' if dashed else ''
    parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{PALE if not dashed else "white"}" stroke="{color}" stroke-width="2"{dash}/>')
    text(parts, x+w/2, y+34, title if isinstance(title, list) else [title], 'label')
    text(parts, x+w/2, y+65+max(0,len(title)-1)*27 if isinstance(title,list) else y+65, body)


def arrow(parts, x1,y1,x2,y2,back=False,dashed=False):
    parts.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{AMBER if back else TEAL}" stroke-width="2.5" marker-end="url(#{"return" if back else "arrow"})"{chr(32)+"stroke-dasharray="+chr(34)+"6 5"+chr(34) if dashed else ""}/>')


def save(name, parts):
    parts.append('</svg>')
    (OUT/name).write_text('\n'.join(parts)+'\n')

p=start('Six participants, one observable payment', 'Six independent Python child processes communicate through supervisor-delivered queues. Authorization moves forward and the issuer decision returns. Merchant captures locally; issuer owns funds; acquirer records illustrative payouts.',1200,650)
labels=[['Payer'],['Merchant','POS'],['Gateway','Processor'],['Acquirer'],['Simulated','Visa/Mastercard'],['Issuer']]
for i,l in enumerate(labels):
    x=30+i*195
    box(p,x,155,165,115,l,body=['Python process'])
    if i<5: arrow(p,x+165,211,x+192,211)
p.append(f'<path d="M 1087.5 270 V 310 H 112.5 V 277" fill="none" stroke="{AMBER}" stroke-width="2.5" marker-end="url(#return)"/>')
p.append('<rect x="390" y="288" width="420" height="40" fill="white"/>')
text(p,600,315,['Issuer decision returns through every participant'],color=AMBER)
box(p,250,375,700,100,'Supervisor',['Inbox queues • stepping • process health • observed events'])
arrow(p,600,375,600,335,dashed=True)
box(p,325,535,550,83,'Browser dashboard',['Live diagram • balances • JSON trace'])
arrow(p,600,530,600,479)
text(p,30,645,['Capture is local to merchant; clearing and settlement run merchant ↔ issuer.'],cls='small',anchor='start')
save('architecture.svg',p)

p=start('Authorization: request forward, decision back','A payment request crosses the payer, merchant, gateway, acquirer and network to the issuer. The issuer checks account and available funds, reserves a hold if approved, then its decision crosses the full reverse path.',1320,765)
xs=[110,330,550,770,990,1210]
for x,l in zip(xs,['Payer','Merchant / POS','Gateway','Acquirer','Network','Issuer']):
    box(p,x-90,125,180,60,l)
    p.append(f'<line x1="{x}" y1="188" x2="{x}" y2="710" stroke="{LINE}" stroke-dasharray="6 5"/>')
for i,y in enumerate([220,265,310,355,400]):
    arrow(p,xs[i],y,xs[i+1],y)
    text(p,(xs[i]+xs[i+1])/2,y-12,['AUTHORIZE'],cls='small')
p.append(f'<rect x="1010" y="420" width="280" height="77" rx="7" fill="{PALE}" stroke="{TEAL}"/>')
text(p,1150,443,['Check token, status, funds','Approve → reserve hold','Posted balance unchanged'],cls='small',gap=20)
for i,y in enumerate([520,565,610,655,700]):
    j=5-i
    arrow(p,xs[j],y,xs[j-1],y,back=True)
    text(p,(xs[j]+xs[j-1])/2,y-12,['AUTH_RESULT'],cls='small',color=AMBER)
text(p,35,745,['Stable payment ID and operation ID remain in every hop; amounts are integer cents.'],cls='small',anchor='start')
save('authorization_sequence.svg',p)

p=start('Payment lifecycle and financial effects','Authorization creates a hold, merchant full capture preserves it, clearing replaces the hold with a posted debit and obligation, and settlement credits merchant proceeds and illustrative fee buckets. A decline creates no hold.',1200,660)
states=[('AUTHORIZED',['Hold reserved']),('CAPTURED',['Full collection intent']),('CLEARED',['Posted debit + obligation']),('SETTLED',['Proceeds + fee buckets'])]
for i,(l,b) in enumerate(states):
    x=45+i*285
    box(p,x,175,255,100,l,b)
    if i<3: arrow(p,x+255,222,x+280,222)
text(p,45,135,['Approved $50 purchase from a $500 fictional account'],anchor='start')
box(p,45,335,255,130,'Authorization',['Posted: $500','Held: $50','Available: $450'])
box(p,330,335,255,130,'Capture',['Posted: $500','Held: $50','Available: $450'])
box(p,615,335,255,130,'Clearing',['Posted: $450 / held: $0','Available: $450','Obligation: $50'])
box(p,900,335,255,130,'Settlement',['Obligation: $0','Merchant: $48.75','Fees: $1.25'])
box(p,45,530,365,90,'DECLINED',['No hold, debit, or proceeds'],color=RED)
text(p,460,552,['Replay: recorded outcome, no new financial effect.','Invalid stage: reject without changing the valid state.','Debit posting at clearing is a simplified teaching convention.'],anchor='start',cls='body')
save('lifecycle.svg',p)

p=start('Cloud evolution: local → VM → independent roles','The working local program can run unchanged in one VM container through an SSH tunnel. A future design would replace queues with managed messaging and store ledger and idempotency state durably. Provider mappings are proposals, not deployments.',1200,650)
box(p,35,165,330,145,'1. Working local package',['Six Python processes','Local queues','In-memory state'])
box(p,435,165,330,145,'2. VM deployment runbook',['Same container','Remote loopback port','SSH tunnel from laptop'])
box(p,835,165,330,145,'3. Future generation',['Independent participants','Managed messaging','Durable financial state'],dashed=True,color=MUTED)
arrow(p,370,235,428,235)
arrow(p,771,235,828,235,dashed=True)
text(p,35,372,['Stage 3 needs new transport, authenticated traffic, concurrency control, recovery, and separate tests.'],anchor='start')
for x,l,b in [(35,'AWS proposal',['ECS services','SQS role queues','RDS PostgreSQL']),(435,'GCP proposal',['Cloud Run services','Pub/Sub subscriptions','Cloud SQL PostgreSQL']),(835,'Azure proposal',['Container Apps','Service Bus queues','Azure PostgreSQL'])]:
    box(p,x,420,330,155,l,b,dashed=True,color=MUTED)
text(p,35,625,['No cloud resources have been provisioned. One-VM runbooks preserve the local payment lesson.'],anchor='start',cls='small')
save('cloud_evolution.svg',p)
