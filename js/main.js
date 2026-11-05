/* ==========================================================================
   Shared behaviour for every page
   1. Footer year
   2. Age, worked out from the birth date (so the CV never goes stale)
   3. Print / save the CV
   4. Copy buttons (not used right now, kept for later)
   5. 3D reveal of text blocks as they scroll into view
   ========================================================================== */

(function () {
  'use strict';

  /* 1. Footer year ------------------------------------------------------- */

  document.querySelectorAll('[data-year]').forEach(function (element) {
    element.textContent = new Date().getFullYear();
  });


  /* 2. Age --------------------------------------------------------------- */

  document.querySelectorAll('[data-birthdate]').forEach(function (element) {
    const birth = new Date(element.dataset.birthdate + 'T00:00:00');
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const birthdayPassed =
      today.getMonth() > birth.getMonth() ||
      (today.getMonth() === birth.getMonth() && today.getDate() >= birth.getDate());
    if (!birthdayPassed) age -= 1;
    element.textContent = age;
  });


  /* 3. Print the CV ------------------------------------------------------ */

  document.querySelectorAll('[data-print]').forEach(function (button) {
    button.addEventListener('click', function () {
      window.print();
    });
  });


  /* 4. Copy buttons -------------------------------------------------------- */

  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      const text = button.dataset.copy;
      const original = button.textContent;

      function done(label) {
        button.textContent = label;
        setTimeout(function () {
          button.textContent = original;
        }, 2000);
      }

      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(
          function () { done('Copied'); },
          function () { done('Select the address and copy it'); }
        );
      } else {
        done('Select the address and copy it');
      }
    });
  });


  /* 5. 3D reveal on scroll ---------------------------------------------- */

  const revealTargets = document.querySelectorAll('[data-reveal], .cv__name');

  if (!('IntersectionObserver' in window)) {
    revealTargets.forEach(function (element) { element.classList.add('is-in'); });
  } else {
    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    revealTargets.forEach(function (element) { observer.observe(element); });
  }
})();