const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);

    if (url.pathname === '/shops') {
      const res = await fetch('https://api.printify.com/v1/shops.json', {
        headers: { 'Authorization': 'Bearer ' + env.PRINTIFY_API_KEY }
      });
      const data = await res.json();
      return new Response(JSON.stringify(data, null, 2), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/debug') {
      const res = await fetch(
        'https://api.printify.com/v1/shops/26790889/products.json?limit=10',
        { headers: { 'Authorization': 'Bearer ' + env.PRINTIFY_API_KEY } }
      );
      const data = await res.json();
      return new Response(JSON.stringify(data, null, 2), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/api/products') {
      const shopId = '26790889';
      const res = await fetch(
        'https://api.printify.com/v1/shops/' + shopId + '/products.json?limit=100',
        { headers: { 'Authorization': 'Bearer ' + env.PRINTIFY_API_KEY } }
      );
      const data = await res.json();
      const products = (data.data || []).map(function(p) {
        const image = (p.images || []).find(function(i) { return i.src; }) || {};
        const prices = (p.variants || []).map(function(v) { return v.price; }).filter(Boolean);
        const minPrice = prices.length ? Math.min.apply(null, prices) / 100 : null;
        const tags = (p.tags || []).map(function(t) { return t.toLowerCase(); });
        const isHoodie = tags.includes('hoodie') || (p.title || '').toLowerCase().includes('hoodie');
        let category = isHoodie ? 'hoodies' : 'shirts';
        if (tags.includes('new')) category += ' new';
        return {
          id: p.id,
          title: p.title,
          description: (p.description || '').replace(/<[^>]+>/g, '').trim().substring(0, 90),
          image: image.src || '',
          price: minPrice ? '$' + minPrice.toFixed(0) : '',
          type: isHoodie ? 'Pullover hoodie' : 'Unisex tee',
          category: category,
          url: 'https://beckywexlincreative.printify.me/products/' + p.id,
          isNew: tags.includes('new'),
        };
      });
      return new Response(JSON.stringify({ products: products }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};