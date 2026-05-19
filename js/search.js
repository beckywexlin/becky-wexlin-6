/* ── SITE-WIDE PRODUCT SEARCH ── */
(function () {
  // Build overlay HTML
  var overlay = document.createElement('div');
  overlay.id = 'search-overlay';
  overlay.innerHTML =
    '<div class="search-overlay-inner">' +
      '<div class="search-bar">' +
        '<input type="text" id="search-input" placeholder="Search shirts, hoodies, tags..." autocomplete="off" />' +
        '<button id="search-close" aria-label="Close search">&times;</button>' +
      '</div>' +
      '<div id="search-results" class="search-results"></div>' +
    '</div>';
  document.body.appendChild(overlay);

  // Inject search button into nav (before cart)
  var cartBtn = document.querySelector('.cart-icon-btn');
  if (cartBtn) {
    var searchBtn = document.createElement('button');
    searchBtn.className = 'nav-search-btn';
    searchBtn.setAttribute('aria-label', 'Search products');
    searchBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
    cartBtn.parentNode.parentNode.insertBefore(
      Object.assign(document.createElement('li'), { innerHTML: '' }),
      cartBtn.parentNode
    );
    cartBtn.parentNode.previousElementSibling.appendChild(searchBtn);

    searchBtn.addEventListener('click', openSearch);
  }

  var input = document.getElementById('search-input');
  var results = document.getElementById('search-results');
  var closeBtn = document.getElementById('search-close');
  var timer;

  function openSearch() {
    overlay.classList.add('active');
    input.value = '';
    results.innerHTML = '';
    setTimeout(function () { input.focus(); }, 100);
    document.body.style.overflow = 'hidden';
  }

  function closeSearch() {
    overlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  closeBtn.addEventListener('click', closeSearch);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeSearch();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSearch();
    // Cmd/Ctrl+K to open search
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      openSearch();
    }
  });

  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(doSearch, 200);
  });

  async function getProducts() {
    var cached = sessionStorage.getItem('bw_products');
    if (cached) return JSON.parse(cached);
    var res = await fetch('https://becky-wexlin-api.beckywexlin.workers.dev/api/products');
    var data = await res.json();
    var products = (data.products || data).map(function (p) {
      return {
        slug: p.slug,
        title: p.title,
        img: (p.images ? p.images[0] : p.img) || '',
        price: (p.variants ? p.variants[0].price : p.price) || '',
        tags: (p.tags || []).join(' ').toLowerCase(),
        desc: (p.description || '').replace(/<[^>]+>/g, '').toLowerCase().substring(0, 200)
      };
    });
    try { sessionStorage.setItem('bw_products', JSON.stringify(products)); } catch (e) {}
    return products;
  }

  async function doSearch() {
    var q = (input.value || '').toLowerCase().trim();
    if (!q) {
      results.innerHTML = '';
      return;
    }
    var products = await getProducts();
    var matches = products.filter(function (p) {
      return p.title.toLowerCase().indexOf(q) > -1 ||
        (p.tags || '').indexOf(q) > -1 ||
        (p.desc || '').indexOf(q) > -1;
    });

    if (!matches.length) {
      results.innerHTML = '<p class="search-empty">No results for "' + q.replace(/</g, '&lt;') + '"</p>';
      return;
    }

    results.innerHTML = matches.slice(0, 12).map(function (p) {
      var imgSrc = p.img ? '/img/' + encodeURIComponent(p.img) : '';
      return '<a class="search-result" href="/' + p.slug + '">' +
        '<div class="search-result-img">' +
          (imgSrc ? '<img src="' + imgSrc + '" alt="' + p.title + '" />' : '') +
        '</div>' +
        '<div class="search-result-info">' +
          '<p class="search-result-title">' + p.title + '</p>' +
          '<p class="search-result-price">$' + p.price + '</p>' +
        '</div>' +
      '</a>';
    }).join('');
  }
})();
