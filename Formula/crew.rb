class Crew < Formula
  desc "Agent team launcher with workspace & project management"
  homepage "https://github.com/FurlanLuka/homebrew-tap"
  url "https://github.com/FurlanLuka/homebrew-tap/archive/refs/tags/v0.6.0.tar.gz"
  sha256 "b2cb6df745d54f6a3fe6362f36c55320c33604c01425672599defd812b4713d1"
  license "MIT"

  depends_on "tmux"

  def install
    bin.install "crew/crew"
  end

  def caveats
    <<~EOS
      crew requires python3 on your PATH.
      If you don't have it: brew install python@3
    EOS
  end

  test do
    assert_match "Agent team launcher", shell_output("#{bin}/crew help")
  end
end
