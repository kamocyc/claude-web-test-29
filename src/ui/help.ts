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
        ['G H J I', '学校 / 消防署 / 警察署 / 病院'],
        ['U Y X', '公園 / 競技場 / 遊園地'],
        ['K L', '高架道路 / 高架線路'],
        ['Q W E R O', '低密度住宅 / 高密度住宅 / 商業 / 工業 / オフィス'],
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
          + '「この順で開業する」を押します。駅の間に線路がなければ自動で敷きます。',
        ),
      ]),
      section('路線をあとから直す', [
        note(
          '「路線」ウィンドウに鉄道もバスも一覧で出ます。行をクリックすると'
          + '地図でその路線だけが強調され、停留所・待ち時間・一周の時間が見られます。',
        ),
        note(
          '待っている人が多いなら「増便」。名前と色も変えられます。'
          + '「停留所を編集」を押すと、いまの停留所が選ばれた状態で路線ツールに切り替わるので、'
          + '駅を足したり（一覧の駅をもう一度クリックして）外したりして'
          + '「この順に変更する」を押すと、名前・色・のべ乗車人数はそのままで経路だけが変わります。',
        ),
      ]),
      section('公園とレジャー', [
        note(
          '市民は仕事と買い物のほかに「おでかけ」をします。'
          + '数日出かけられないと幸福度が下がるので、公園・競技場・遊園地のどれかが要ります。',
        ),
        note(
          '公園は最も安く、まわりの地価をいちばん強く上げます（範囲は狭い）。'
          + '競技場と遊園地は遠くからでも人を呼びますが、1日に入れる人数に限りがあり、'
          + '騒音も出ます。市民は「魅力÷距離」で行き先を選ぶので、'
          + '住宅地の中の小さな公園がいちばん効きます。',
        ),
        note(
          '市民には週に1日の休みがあり（曜日は人ごとにばらばら）、その日は出勤せず、'
          + '昼間に出かけます。詳細ウィンドウでその人の休みの曜日が分かります。',
        ),
      ]),
      section('病院と健康', [
        note(
          '健康は学歴と違って下がります。病院が道路で届く範囲では上がり、'
          + '届かない場所や騒音・治安の悪い場所では下がります。幸福度に直接効きます。',
        ),
      ]),
      section('条例', [
        note(
          '「条例」ウィンドウで5つの条例を施行できます。効果はすでにある仕組みの数字を'
          + '1つ動かすだけで、費用は毎日の支出です（乗車人数・建物数・人口・公園の数に比例）。'
          + '建設費と違って残高が足りなくても止まらないので、赤字のまま放置しないでください。',
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
