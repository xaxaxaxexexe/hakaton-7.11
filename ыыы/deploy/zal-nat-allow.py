#!/usr/bin/env python3
"""Keep the hosting NAT source reachable when Remnanode rebuilds its nft chains."""
import json
import subprocess

NAT_IP = '31.59.190.14'
TAG = 'zal-trusted-nat'

def nft(*args):
    return subprocess.run(['nft', *args], capture_output=True, text=True)

for chain in ('input', 'forward'):
    result = nft('-j', 'list', 'chain', 'ip', 'remnanode', chain)
    if result.returncode:
        continue  # Docker/node may not have created its table yet; timer retries.
    rules = json.loads(result.stdout)['nftables']
    if not any(item.get('rule', {}).get('comment') == TAG for item in rules):
        result = nft('insert', 'rule', 'ip', 'remnanode', chain, 'ip', 'saddr', NAT_IP,
                     'tcp', 'dport', '{ 22, 80, 443 }', 'counter', 'accept', 'comment', TAG)
        if result.returncode:
            raise RuntimeError('Could not install trusted NAT exception')
# Remove only this shared proxy from temporary source bans.
for name in ('torrent-blocker', 'ingress-filter-ip'):
    nft('delete', 'element', 'ip', 'remnanode', name, '{ '+NAT_IP+' }')
