// The depth panel in the corner of the home page: how far down the page you
// are, read as metres from the "Depth 040 m: ..." label of each section and
// counted smoothly in between. Decoration only: hidden from assistive
// technology, absent without this script, and hidden by CSS on narrow screens.
(function () {
  var home = document.querySelector('.home');
  var zones = home ? Array.prototype.slice.call(home.querySelectorAll(':scope > .zone')) : [];
  if (zones.length < 2) return;

  var depths = [], names = [], last = 0;
  zones.forEach(function (zone, i) {
    var label = zone.querySelector('.depth');
    var text = label ? label.textContent : '';
    var metres = /(\d+)\s*m/.exec(text);
    // A section without a number (the sea floor, the sand) continues below the last one.
    last = metres ? Number(metres[1]) : last + (i ? 120 : 0);
    depths.push(last);
    names.push((text.split(':')[1] || '').trim());
  });

  var panel = document.createElement('div');
  panel.className = 'hud';
  panel.setAttribute('aria-hidden', 'true');
  panel.innerHTML = 'Depth<b></b><div class="bar"><i></i></div><small></small>';
  home.appendChild(panel);
  var value = panel.querySelector('b'), bar = panel.querySelector('.bar i'), name = panel.querySelector('small');

  function update() {
    var range = document.documentElement.scrollHeight - window.innerHeight;
    var progress = range > 0 ? Math.min(1, Math.max(0, window.scrollY / range)) : 0;
    var eye = window.scrollY + window.innerHeight * 0.35;
    var i = 0;
    zones.forEach(function (zone, k) { if (zone.offsetTop <= eye) i = k; });
    var within = Math.min(1, Math.max(0, (eye - zones[i].offsetTop) / zones[i].offsetHeight));
    var next = i + 1 < depths.length ? depths[i + 1] : depths[i];
    var floor = i >= zones.length - 2;
    value.textContent = floor ? 'FLOOR' : ('00' + Math.round(depths[i] + (next - depths[i]) * within)).slice(-3) + ' m';
    bar.style.width = 'calc(' + progress * 100 + '% - 4px)';
    name.textContent = names[i] || 'the sand';
  }
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
})();
