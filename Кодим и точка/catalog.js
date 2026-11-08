(function(root) {
  const items = [
    {id:'popcorn-s',title:'Попкорн S',detail:'Маленький · солёный',price:20000,kind:'popcorn',size:'S',confirmed:true},
    {id:'popcorn-m',title:'Попкорн M',detail:'Средний · солёный',price:35000,kind:'popcorn',size:'M',confirmed:true},
    {id:'popcorn-l',title:'Попкорн L',detail:'Большой · солёный',price:55000,kind:'popcorn',size:'L',confirmed:true},
    {id:'lipton',title:'Lipton',detail:'Зелёный чай · 0,5 л',price:18000,kind:'tea',confirmed:false},
    {id:'cola',title:'Добрый Кола',detail:'Газированный напиток · 0,5 л',price:18000,kind:'cola',confirmed:false},
    {id:'water',title:'Вода',detail:'Без газа · 0,5 л',price:12000,kind:'water',confirmed:false},
    {id:'chips',title:'Чипсы',detail:'Сыр · 70 г',price:20000,kind:'chips',confirmed:false},
  ];
  if (typeof module !== 'undefined') module.exports=items; else root.StadiumCatalog=items;
})(typeof window === 'undefined' ? globalThis : window);
