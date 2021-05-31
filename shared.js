var backdrop = document.querySelector('.backdrop');
var modal = document.querySelector('.modal');
var modalNoButton = document.querySelector('.modal__action--negative');
var selectPlanButtons = document.querySelectorAll('.plan button');
var toggleButton = document.querySelector('.toggle-button');
var mobileNav = document.querySelector('.mobile-nav');

// console.dir(backdrop);

for (var i = 0; i < selectPlanButtons.length; i++) {
    selectPlanButtons[i].addEventListener('click', function() {
        modal.classList.add('open')
        backdrop.classList.add('open')
        // modal.style.display = 'block';
        // backdrop.style.display = 'block';
    });
}

if (modalNoButton) {
    modalNoButton.addEventListener('click', closeModal);
}

backdrop.addEventListener('click', function() {
    mobileNav.classList.remove('open')
    closeModal();
});

function closeModal() {
    if (modal) {
        modal.classList.remove('open')
    }
    backdrop.classList.remove('open')
}

toggleButton.addEventListener('click', function() {
    mobileNav.classList.add('open')
    backdrop.classList.add('open')
});