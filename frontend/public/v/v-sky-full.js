/* Valheim /v: Canvallax — небо, звёзды, облака. Любая ошибка не должна ломать страницу. */
(function initValheimSky() {
  try {
    if (typeof window.Canvallax !== "function") return;

    var CLOUD_SPRITE_SRC =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEYAAABGCAMAAABG8BK2AAAAYFBMVEX///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8GYpHzAAAAIHRSTlMAAwcLDxIWGh8kKzI5QEhPVl9qc3uEi5Sdpa64wcrV4c6KdP8AAAOeSURBVHgBndQJkvM8DoNhS+nv/ieONBH8FIs1nb83ZLfF1wBFZ17vNMZ8fPz79/GY46Xre8F85kRzzhdk/A2TOpSARpF/g0mdaI8XZjg47leA32Jo3wbEooNE/SFGrPOAiPxC+xaDAxBTxQqFoW8wGGof89E4j8nQUceo621h/KY8GuXx4Mg10vRZlPd55JCEnXlIQX7cE8pNp8Dob4oY8LjZTny8QEMo2o2hSqT5YImxchVNbpgZ3oVR4xVUgOlGS5fFKCPSWDY4Yu1xIKyEEqLfE0UUKcoJ9MFVsAhnaOpEGW4gyxFyLitOeRhZO8NJur1hKpWWCV03oaG9yYcYXvD7UPbetVOMNwqlWH6/b7sp29G1Z5g6LFGaY9uYB2A6M7evtVco3U3M1CCopOlNY8Q7cdZahxIMTpv7meR2NghWDqdu8MTZzwMqN+RaBkmdUgf7wMfN1d1cNSAFMdhQ3tLXu2STuclylwYL5QYhsGyLz499bcgxK1F5SmumvaoRrIwSjYutaGbVZIgze6wegLO6i8MD2kJ1N1cYKAUXTLnRWxtnYrMONWRRD+EsA3utw4mnKxNCZRgplK5T05ycvaaZCmtAOEKl+p4ge70k06mcdrQoPgGpbY1EboNyY7/ZHVsfK1BLhBAdCA5MGd719b0gUOJmg9vc5hf3E+K2y1EQDnCjxoGs3t84WiA6zI253rVy6MRnSKNxJtQcRY3xL90MkN6DYGZHI3zBMaF1NcoUQ3Oll+9RBqHb1uIzSTmv9LtQOJbC7Ci/fRsivh0+sBrYwix3GKe8No5yHJTDaZqhqOp8KC6BdmXrFKFaXUUWk7uCLsRPbuAZrmsPjCANBKChIZj/97IBzSJq3pgpymiYRmnxMLG9YbinUGCk5rxbUhJDy/yH+C5U3wP1FQWDL5AtWpNQm0IRz/ys+psCTSKuCObTjY3KhLoCrbUY7ZgIqHRXrTSFHxwfFjcM1fWF8devtJPK2XtM6nAOpcrCXDlVR967qRi6XOY78NJsi95gcsJynMXF2k6gAFFhVFGLz0loz5u0HGoEGF6qOoVgC6cOB6iBb0Ixue66p+p8F+v17VkhUTqGXP6pVptC8JU07z0Ga5VqjmUpvBvuC8wpej4bJiXK+ZHnazfXyfUSipxPVJQvMTjppUKlFUVvv8PIVftrSIRD+Q6DQ7a47wzE9xjaYJk1Fty1v8CYauOLm+fv3Cikjv4lBqVCAP6n/gfZhdXQlm1mfwAAAABJRU5ErkJggg==";
    var REBUILD_DELAY_MS = 160;
    var state = window.__valheimSkyState || (window.__valheimSkyState = {});

    function isEmbedded() {
      try {
        return window.self !== window.top;
      } catch (e) {
        return true;
      }
    }

    function isPreview() {
      return (
        isEmbedded() ||
        document.documentElement.dataset.embedded === "true" ||
        /(?:^|[?&])preview=1(?:&|$)/.test(window.location.search)
      );
    }

    function mediaFlags() {
      return {
        prefersReducedMotion:
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        isMobileFixedBg:
          typeof window.matchMedia === "function" &&
          window.matchMedia("(max-width: 700px), (hover: none) and (pointer: coarse)").matches,
        isPreview: isPreview(),
      };
    }

    function viewportSize() {
      return {
        width: Math.max(
          1,
          window.innerWidth ||
            document.documentElement.clientWidth ||
            document.body.clientWidth ||
            800
        ),
        height: Math.max(
          1,
          window.innerHeight ||
            document.documentElement.clientHeight ||
            document.body.clientHeight ||
            600
        ),
      };
    }

    function createGradientFill(height) {
      var canvas = document.createElement("canvas");
      var ctx = canvas.getContext("2d");
      if (!ctx) return "#07588A";
      var g = ctx.createLinearGradient(0, 0, 0, height);
      g.addColorStop(0, "#07588A");
      g.addColorStop(1, "#E1F6F4");
      return g;
    }

    function randomRange(min, max) {
      return Math.random() * (max - min) + min;
    }

    function removeBgCanvases() {
      var canvases = document.querySelectorAll("canvas.bg-canvas");
      Array.prototype.forEach.call(canvases, function (canvas) {
        if (canvas && canvas.parentNode) {
          canvas.parentNode.removeChild(canvas);
        }
      });
    }

    function bestCandidateSampler(w, h, numCandidates) {
      var samples = [];

      function findDistance(a, b) {
        var dx = a[0] - b[0];
        var dy = a[1] - b[1];
        return dx * dx + dy * dy;
      }

      function findClosest(c) {
        var si = samples.length;
        var sample;
        var closest;
        var dist;
        var closestDistance;
        while (si--) {
          sample = samples[si];
          dist = findDistance(sample, c);
          if (!closestDistance || dist < closestDistance) {
            closest = sample;
            closestDistance = dist;
          }
        }
        return closest;
      }

      function getSample() {
        var bestCandidate;
        var bestDistance = 0;
        var ii = 0;
        var c;
        var d;
        c = [Math.random() * w, Math.random() * h];
        if (samples.length < 1) {
          bestCandidate = c;
        } else {
          for (; ii < numCandidates; ii++) {
            c = [Math.random() * w, Math.random() * h];
            var closest = findClosest(c);
            if (!closest) continue;
            d = findDistance(closest, c);
            if (d > bestDistance) {
              bestDistance = d;
              bestCandidate = c;
            }
          }
          if (!bestCandidate) {
            bestCandidate = [Math.random() * w, Math.random() * h];
          }
        }
        if (bestCandidate) samples.push(bestCandidate);
        return bestCandidate;
      }

      getSample.all = function () {
        return samples;
      };
      getSample.samples = samples;
      return getSample;
    }

    function randomizedCloud(image) {
      var canvas = document.createElement("canvas");
      var ctx = canvas.getContext("2d");
      if (!ctx) return canvas;
      var cw = (canvas.width = randomRange(400, 700));
      var ch = (canvas.height = randomRange(200, 260));
      var iw = image.width;
      var ih = image.height;
      var halfw = iw / 2;
      var halfh = ih / 2;
      var iter = Math.ceil(randomRange(20, 90));
      var randScale;
      var maxScale = 2.5;
      var fullPi = Math.PI / 2;
      while (iter--) {
        randScale = randomRange(0.4, maxScale);
        ctx.globalAlpha = Math.random() - 0.2;
        ctx.translate(
          randomRange(halfw, cw - iw * maxScale * 1.3),
          randomRange(halfh + halfh / 4, ch - ih * maxScale)
        );
        ctx.scale(randScale, randomRange(randScale - 0.3, randScale));
        ctx.translate(halfw, halfh);
        ctx.rotate(randomRange(0, fullPi));
        ctx.drawImage(image, -halfw, -halfh);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      return canvas;
    }

    function buildSky() {
      var flags = mediaFlags();
      if (flags.isPreview) {
        document.documentElement.classList.add("sky-static");
        return null;
      }

      var view = viewportSize();
      var width = view.width;
      var height = view.height;
      var can = Canvallax({
        parent: document.body,
        className: "bg-canvas",
        damping: flags.isMobileFixedBg ? 1 : 40,
        tracking: flags.isMobileFixedBg ? false : "scroll",
        animating: flags.prefersReducedMotion ? false : true,
      });
      if (!can || typeof can.add !== "function") return null;

      var destroyed = false;
      var gradient = Canvallax.Rectangle({
        width: width * 1.5,
        height: height * 1.1,
        zIndex: 1,
        fill: createGradientFill(height),
      });
      var stars = [];
      var number = flags.isMobileFixedBg ? 180 : 300;
      var i = 0;
      var distance;
      for (; i < number; i++) {
        distance = randomRange(0.1, 0.3);
        stars.push(
          Canvallax.Circle({
            x: Math.random() * width,
            y: Math.random() * height * 0.9,
            distance: distance,
            size: 4,
            fill: "#FFF",
          })
        );
      }

      can.add(gradient);
      can.add(stars);

      function safeRender() {
        if (!destroyed && typeof can.render === "function") {
          can.render();
        }
      }

      function syncCanvas() {
        if (destroyed) return;
        var next = viewportSize();
        width = next.width;
        height = next.height;

        if (can.canvas) {
          can.canvas.width = width;
          can.canvas.height = height;
          can.canvas.style.width = "100%";
          can.canvas.style.height = "100%";
        }

        gradient.width = width * 1.5;
        gradient.height = height * 1.1;
        gradient.fill = createGradientFill(height);

        var si = stars.length;
        while (si--) {
          var star = stars[si];
          if (!star) continue;
          star.x = Math.min(star.x, width);
          star.y = Math.min(star.y, height * 0.9);
        }

        var j = can.elements.length;
        while (j--) {
          var el = can.elements[j];
          if (!el) continue;
          el.maxX = width;
        }

        safeRender();
      }

      function cloudCount() {
        var count = Math.floor((width * height) / (510 * 260));
        count = Math.max(0, Math.min(120, count));
        if (flags.isMobileFixedBg) {
          count = Math.min(count, 42);
        }
        return count;
      }

      var getCandidate = bestCandidateSampler(width, height, 10);
      var cloudImg = new Image();
      var handleCloudLoad = function () {
        if (destroyed) return;
        var cnt = cloudCount();
        var rand;
        var pos;
        var tex;
        var cloud;
        while (cnt--) {
          rand = randomRange(0.4, 1.2);
          pos = getCandidate();
          if (!pos) continue;
          tex = randomizedCloud(cloudImg);
          cloud = Canvallax.Image({
            image: tex,
            width: tex.width,
            height: tex.height,
            zIndex: rand * 13,
            x: pos[0],
            y: pos[1],
            opacity: rand < 0.8 ? 0.8 : rand,
            distance: rand,
            maxX: width,
            speed: rand * randomRange(0.2, 0.4),
            postRender: function () {
              this.x =
                this.x * this.distance > -this.width
                  ? this.x - this.speed
                  : this.maxX + this.width * 2;
            },
          });
          can.add(cloud);
        }
        safeRender();
      };

      cloudImg.addEventListener("load", handleCloudLoad);
      cloudImg.src = CLOUD_SPRITE_SRC;

      syncCanvas();
      safeRender();

      return {
        syncCanvas: syncCanvas,
        destroy: function () {
          if (destroyed) return;
          destroyed = true;
          cloudImg.removeEventListener("load", handleCloudLoad);
          can.animating = false;
          can.elements = [];
          if (can.canvas) {
            var ctx = can.canvas.getContext("2d");
            if (ctx) {
              ctx.clearRect(0, 0, can.canvas.width, can.canvas.height);
            }
            if (can.canvas.parentNode) {
              can.canvas.parentNode.removeChild(can.canvas);
            }
          }
        },
      };
    }

    function mountSky() {
      if (state.activeSky && typeof state.activeSky.destroy === "function") {
        state.activeSky.destroy();
      }
      removeBgCanvases();
      document.documentElement.classList.remove("sky-static");
      state.activeSky = buildSky();
    }

    if (state.resizeHandler) {
      window.removeEventListener("resize", state.resizeHandler);
    }
    if (state.resizeTimer) {
      clearTimeout(state.resizeTimer);
    }
    if (state.activeSky && typeof state.activeSky.destroy === "function") {
      state.activeSky.destroy();
    }
    removeBgCanvases();

    state.resizeHandler = function () {
      if (state.activeSky && typeof state.activeSky.syncCanvas === "function") {
        state.activeSky.syncCanvas();
      }
      clearTimeout(state.resizeTimer);
      state.resizeTimer = window.setTimeout(function () {
        mountSky();
      }, REBUILD_DELAY_MS);
    };

    window.addEventListener("resize", state.resizeHandler);
    mountSky();
  } catch (err) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[v-sky-full]", err);
    }
    document.documentElement.classList.add("sky-error");
  }
})();
