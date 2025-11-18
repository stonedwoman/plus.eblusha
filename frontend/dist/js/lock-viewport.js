(function () {
  function setVh() {
    try {
      var vv = window.visualViewport ? window.visualViewport.height : null;
      var ih = window.innerHeight;
      var ch = document.documentElement ? document.documentElement.clientHeight : null;
      
      // На мобильных устройствах при первой загрузке innerHeight может быть неточным
      // Используем visualViewport.height если доступно, иначе innerHeight
      var base = vv || ih || ch || 0;
      
      // Если значение слишком мало (меньше 300px), возможно это еще не правильная высота
      // В этом случае используем innerHeight как fallback
      if (base < 300 && ih && ih > base) {
        base = ih;
      }
      
      if (base <= 0) base = ih || ch || vv || window.screen.height || 800;
      
      var h = base * 0.01;
      var root = document.documentElement;
      root.style.setProperty('--vh', h + 'px');
      root.style.setProperty('--vvh', h + 'px');

      // keyboard inset (best-effort): how much visual viewport eats from innerHeight
      var v = window.visualViewport;
      var kb = 0;
      if (v && typeof v.height === 'number' && typeof window.innerHeight === 'number') {
        var ot = v.offsetTop || 0;
        var vvh_val = v.height;
        var ih_val = window.innerHeight;
        
        // Calculate keyboard height: on iOS, when keyboard is open, offsetTop increases
        // Keyboard height ≈ offsetTop when keyboard is visible
        if (ot > 0 && vvh_val < ih_val) {
          // Standard case: visual viewport shrinks
          kb = Math.round(ih_val - vvh_val);
        } else if (ot > 50) {
          // iOS case: visual viewport doesn't shrink, but offsetTop increases
          // Estimate keyboard height from offsetTop (rough approximation)
          kb = Math.max(0, Math.round(ot - 50)); // Subtract some threshold
        }
      }
      root.style.setProperty('--kb', kb + 'px');
      
      // Prevent iOS auto-scroll: reset page scroll when iOS tries to scroll
      if (v && v.offsetTop > 0) {
        if (window.pageYOffset > 0 || document.documentElement.scrollTop > 0) {
          window.scrollTo(0, 0);
          document.documentElement.scrollTop = 0;
        }
      }
    } catch (e) {}
  }
  
  // Вызываем сразу при загрузке скрипта
  setVh();
  
  // Вызываем после загрузки DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setVh();
      // Дополнительный вызов после небольшой задержки для мобильных устройств
      setTimeout(setVh, 100);
      setTimeout(setVh, 300);
    });
  } else {
    // DOM уже загружен
    setTimeout(setVh, 0);
    setTimeout(setVh, 100);
    setTimeout(setVh, 300);
  }
  
  // Вызываем после полной загрузки страницы
  window.addEventListener('load', function() {
    setVh();
    setTimeout(setVh, 100);
  }, { passive: true });
  
  // Обработчики событий
  window.addEventListener('resize', setVh, { passive: true });
  window.addEventListener('orientationchange', function () { 
    setTimeout(setVh, 100);
    setTimeout(setVh, 300);
  }, { passive: true });
  
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setVh, { passive: true });
    window.visualViewport.addEventListener('scroll', setVh, { passive: true });
  }
  
  // Дополнительная проверка при фокусе окна (для случаев, когда пользователь возвращается на вкладку)
  window.addEventListener('focus', function() {
    setTimeout(setVh, 50);
  }, { passive: true });
  
  // На мобильных устройствах первое взаимодействие (touchstart/scroll) может скрыть адресную строку
  // и изменить высоту viewport, поэтому обновляем высоту при первом взаимодействии
  var hasInteracted = false;
  function handleFirstInteraction() {
    if (hasInteracted) return;
    hasInteracted = true;
    setTimeout(setVh, 0);
    setTimeout(setVh, 100);
    setTimeout(setVh, 300);
  }
  
  // Обрабатываем первое взаимодействие пользователя
  document.addEventListener('touchstart', handleFirstInteraction, { passive: true, once: true });
  document.addEventListener('scroll', handleFirstInteraction, { passive: true, once: true });
  window.addEventListener('scroll', handleFirstInteraction, { passive: true, once: true });

  // Prevent zoom (pinch/double-tap) on iOS Safari
  function prevent(e) { try { e.preventDefault(); } catch(_) {} }
  document.addEventListener('gesturestart', prevent, { passive: false });
  var lastTouchEnd = 0;
  document.addEventListener('touchend', function (e) {
    var now = Date.now();
    if (now - lastTouchEnd <= 300) { try { e.preventDefault(); } catch(_) {} }
    lastTouchEnd = now;
  }, { passive: false });
})();


