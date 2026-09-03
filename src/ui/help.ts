import { note, section } from './widgets';

/**
 * Everything the game used to say unprompted, in one window nobody has to
 * look at.
 *
 * The panels were full of standing explanations -- how to follow a citizen,
 * what raises land value, why a district can be dark while the city has
 * spare generation. Each was true and each was in the way of the numbers
 * beside it. They are collected here instead, behind the "？" in the
 * toolbar, next to the controls and shortcuts that had only ever been in the
 * README. Written once at start-up: nothing in it changes with the city.
 */
export class HelpPanel {
  constructor(root: HTMLElement) {
    root.innerHTML = '';
    root.append(
      section('マウス', [keys([
        ['左ドラッグ', '選んだツールで描く'],
        ['右ドラッグ', '地図を動かす'],
        ['ホイール', 'ズーム'],
        ['クリック', '選択ツールで、建物・市民・トラックを見る'],
      ])]),
      section('ツール', [keys([
        ['1〜7', '選択 / 道路 / 線路 / 駅 / 路線 / 発電所 / 撤去'],
        ['8 9', 'バス停 / バス系統'],
        ['G H J', '学校 / 消防署 / 警察署'],
        ['K L', '高架道路 / 高架線路'],
        ['Q W E R T', '低密度住宅 / 高密度住宅 / 商業 / 工業 / オフィス'],
        ['A S D F', '農業 / 林業 / 漁業 / 鉱業'],
      ])]),
      section('表示', [keys([
        ['Space', '一時停止'],
        ['Z', '区画表示'],
        ['0 T P N V', 'オーバーレイ: 通常 / 渋滞 / 電力 / 騒音 / 地価'],
        ['C B M', 'オーバーレイ: 治安 / 公共カバー / 標高'],
      ])]),
      section('市民を1人追いかける', [
        note(
          '市民をクリックしてから、速度を ×0.25 にして「カメラで追う」を入れると、'
          + '家を出て、駅で待ち、渋滞に捕まり、職場に着くまでをそのまま見られます。'
          + '駅をクリックすれば、ホームで待っている人数と発着する路線が分かります。',
        ),
      ]),
      section('路線のつくりかた', [
        note(
          '「路線」ツールに切り替えて、駅を通したい順に2つ以上クリックし、'
          + '「この順で路線を作る」を押します。駅の間に線路がなければ自動で敷きます。',
        ),
      ]),
      section('坂道と立体交差', [
        note(
          '地形には高低差があります。坂は登るほど遅く、荷物を積んだトラックはとくに遅くなります。'
          + '線路は1タイルにつき高低差1までしか登れないので、等高線に沿わせるか高架にします。',
        ),
        note(
          '「高架道路」「高架線路」は1回ごとに1段持ち上げます。線路の上を1段またげば踏切ではなく'
          + '立体交差になり、遮断機は下りません。水の上に架ければ橋になり、対岸へ渡れます。',
        ),
      ]),
      section('電気', [
        note(
          '電線は道路の下を通ります。つながっていない道路網は別々の電力網になるので、'
          + '街全体では足りていても、道路で繋がっていない地区は停電します。'
          + '道路で繋ぐか、その地区にも発電所を建ててください。',
        ),
      ]),
      section('地価', [
        note(
          '地価を上げるには、駅と商店を近くに、工場と幹線道路を遠くに。水辺と森も効きます。'
          + '地価が低いと高密度住宅は建たず、住民の幸福度も下がります。',
        ),
      ]),
      section('街が育たないとき', [
        note(
          '警告ウィンドウを開いてください。困っている建物には地図の上にアイコンが出ていて、'
          + '警告の「？」に対処法が書いてあります。',
        ),
      ]),
    );
  }
}

/** Shortcut on the left, what it does on the right, in a grid that wraps. */
function keys(rows: ReadonlyArray<[string, string]>): HTMLElement {
  const dl = document.createElement('dl');
  dl.className = 'keys';
  for (const [key, meaning] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = meaning;
    dl.append(dt, dd);
  }
  return dl;
}
