export const rooms = [
  { id: 'general', name: 'General', description: 'Introductions, questions, and everything else.' },
  { id: 'study-lounge', name: 'Study Lounge', description: 'Coursework, exams, and finding a study partner.' },
  { id: 'university-careers', name: 'University & Careers', description: 'Applications, university choices, and what comes next.' },
  { id: 'life-abroad', name: 'Life Abroad', description: 'Moving countries and settling into a new school.' },
  { id: 'culture-exchange', name: 'Culture Exchange', description: 'Languages, traditions, and things you miss from home.' },
];

export const roomById = Object.fromEntries(rooms.map(room => [room.id, room]));
