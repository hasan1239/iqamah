// Dhuhr and Zawal fall either side of noon: 11:54 in late-autumn GMT, 1:20 in
// BST. Timetable CSVs store bare 12h times ("11:54") with no AM/PM, so a fixed
// "afternoon" flag turns 11:54 into 23:54. Pass MIDDAY as isAM for these and
// resolve it per value: 10:xx and 11:xx are morning, everything else afternoon.
export const MIDDAY = 'midday';

export function resolveIsAM(isAM, hours) {
  return isAM === MIDDAY ? hours >= 10 && hours <= 11 : isAM;
}
