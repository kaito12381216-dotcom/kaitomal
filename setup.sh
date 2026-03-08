#!/bin/bash
# Grand-Master Mail — かんたんセットアップスクリプト
# 使い方: このファイルをダブルクリック、または
#   bash setup.sh

set -e

echo ""
echo "════════════════════════════════════"
echo "  Grand-Master Mail セットアップ"
echo "════════════════════════════════════"
echo ""

# ── Node.js チェック ──
if ! command -v node &>/dev/null; then
  echo "⚠️  Node.js がインストールされていません。"
  echo ""
  echo "  ① 下のURLをブラウザで開いてください:"
  echo "     https://nodejs.org/ja"
  echo "  ② 「LTS版」をダウンロードしてインストール"
  echo "  ③ このスクリプトをもう一度実行してください"
  echo ""
  open "https://nodejs.org/ja" 2>/dev/null || true
  exit 1
fi

NODE_VER=$(node --version)
echo "✅  Node.js $NODE_VER — OK"

# ── フォルダをデスクトップに作る ──
DEST="$HOME/Desktop/GrandMasterMail"
mkdir -p "$DEST"

# ── server.js と HTML をコピー ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$SCRIPT_DIR/server.js" ] || [ ! -f "$SCRIPT_DIR/grand-master-mail.html" ]; then
  echo ""
  echo "❌  server.js か grand-master-mail.html が見つかりません"
  echo "    このスクリプトと同じフォルダに置いてください"
  exit 1
fi

cp "$SCRIPT_DIR/server.js"              "$DEST/server.js"
cp "$SCRIPT_DIR/grand-master-mail.html" "$DEST/grand-master-mail.html"

echo "✅  ファイルをデスクトップの GrandMasterMail フォルダにコピーしました"

# ── メールアドレスとパスワードを入力 ──
echo ""
echo "────────────────────────────────────"
echo "  メールアカウントの設定"
echo "────────────────────────────────────"
echo ""
read -p "  メールアドレスを入力してください: " EMAIL
echo ""
read -s -p "  アプリパスワードを入力してください (入力は見えません): " PASSWORD
echo ""

if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ]; then
  echo ""
  echo "⚠️  入力が空です。後で server.js を直接編集してください"
else
  # server.js の設定を書き換える
  sed -i '' \
    "s|email:    '',|email:    '$EMAIL',|" \
    "$DEST/server.js"
  sed -i '' \
    "s|password: '',|password: '$PASSWORD',|" \
    "$DEST/server.js"
  echo ""
  echo "✅  アカウント設定を保存しました"
fi

# ── 起動スクリプト作成 ──
cat > "$DEST/起動する.command" << 'LAUNCHER'
#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo "Grand-Master Mail を起動しています..."
echo ""

# Node.js のパスを探す
for p in /usr/local/bin/node /opt/homebrew/bin/node ~/.nvm/versions/node/*/bin/node; do
  [ -f "$p" ] && NODE="$p" && break
done
NODE="${NODE:-node}"

"$NODE" server.js &
SERVER_PID=$!

sleep 2

# ブラウザで開く
open "http://localhost:8888"

echo ""
echo "ブラウザでアプリが開きます"
echo "終了するにはこのウィンドウを閉じてください"
echo ""

# サーバーが終了するまで待つ
wait $SERVER_PID
LAUNCHER

chmod +x "$DEST/起動する.command"

echo "✅  起動ボタンを作成しました"

# ── 完了 ──
echo ""
echo "════════════════════════════════════"
echo "  🎉  セットアップ完了！"
echo "════════════════════════════════════"
echo ""
echo "  使い方:"
echo "  デスクトップの「GrandMasterMail」フォルダを開いて"
echo "  「起動する.command」をダブルクリックするだけ！"
echo ""

# フォルダを開く
open "$DEST"
